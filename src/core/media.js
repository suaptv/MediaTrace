const HEAD_BYTES = 1024 * 1024;
const FLV_HEAD_BYTES = 256 * 1024;
const MAX_PLAYLIST_DEPTH = 3;

export function classifyUrl(rawUrl, contentType = "") {
  let pathname = ""; let hostname = ""; let declaredMime = "";
  try {
    const parsed = new URL(rawUrl);
    pathname = parsed.pathname.toLowerCase();
    hostname = parsed.hostname;
    declaredMime = (parsed.searchParams.get("mime_type") ?? parsed.searchParams.get("mime") ?? "").toLowerCase();
  } catch { return null; }
  const type = contentType.toLowerCase();
  if (/(?:^|\.)googlevideo\.com$/i.test(hostname) && pathname.endsWith("/videoplayback")) return "youtube";
  if (/\.m4s$/i.test(pathname)) return "m4s";
  if (/\.m3u8(?:$|\?)/i.test(rawUrl) || type.includes("mpegurl")) return "m3u8";
  if (/\.mp4$/i.test(pathname) || type.includes("video/mp4") || declaredMime === "video_mp4" || declaredMime.startsWith("video/mp4")) return "mp4";
  if (/\.flv$/i.test(pathname) || type.includes("video/x-flv")) return "flv";
  if (/\.(?:ts|cmfv|cmfa)$/i.test(pathname) || type.includes("video/mp2t") || type.includes("iso.segment")) return "stream";
  return null;
}

export function inferYouTubeTrack(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return "unknown"; }
  const mime = (url.searchParams.get("mime") ?? "").toLowerCase();
  const itag = Number(url.searchParams.get("itag"));
  if (mime.startsWith("audio/")) return "audio";
  // Legacy/progressive YouTube formats contain both video and audio.
  if ([5, 6, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46, 59, 78].includes(itag)) return "muxed";
  if (mime.startsWith("video/")) return "video";
  return "unknown";
}

export function inferM4sTrack(rawUrl, contentType = "") {
  const type = contentType.toLowerCase();
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  let name = "";
  try { name = new URL(rawUrl).pathname.toLowerCase(); } catch { return "unknown"; }
  if (/(?:^|[\/_-])audio(?:[\/_-]|\.|$)|302\d{2}\.m4s$/.test(name)) return "audio";
  if (/(?:^|[\/_-])video(?:[\/_-]|\.|$)|300\d{2}\.m4s$/.test(name)) return "video";
  return "unknown";
}

function readUint24(view, offset) {
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
}

function readAmf0(view, state, limit) {
  if (state.offset >= limit) throw new Error("AMF truncated");
  const type = view.getUint8(state.offset++);
  if (type === 0) { const value = view.getFloat64(state.offset); state.offset += 8; return value; }
  if (type === 1) return Boolean(view.getUint8(state.offset++));
  if (type === 2) {
    const length = view.getUint16(state.offset); state.offset += 2;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + state.offset, length); state.offset += length;
    return new TextDecoder().decode(bytes);
  }
  if (type === 5 || type === 6) return null;
  if (type === 3 || type === 8) {
    if (type === 8) state.offset += 4;
    const result = {};
    while (state.offset + 3 <= limit) {
      const length = view.getUint16(state.offset); state.offset += 2;
      if (length === 0 && view.getUint8(state.offset) === 9) { state.offset += 1; break; }
      const bytes = new Uint8Array(view.buffer, view.byteOffset + state.offset, length); state.offset += length;
      const key = new TextDecoder().decode(bytes);
      result[key] = readAmf0(view, state, limit);
    }
    return result;
  }
  if (type === 10) {
    const count = view.getUint32(state.offset); state.offset += 4;
    return Array.from({ length: count }, () => readAmf0(view, state, limit));
  }
  if (type === 11) { const value = new Date(view.getFloat64(state.offset)); state.offset += 10; return value; }
  throw new Error(`Unsupported AMF type ${type}`);
}

export function parseFlvMetadata(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 13 || view.getUint8(0) !== 0x46 || view.getUint8(1) !== 0x4c || view.getUint8(2) !== 0x56) return null;
  let offset = view.getUint32(5) + 4;
  while (offset + 11 <= view.byteLength) {
    const tagType = view.getUint8(offset);
    const dataSize = readUint24(view, offset + 1);
    const dataAt = offset + 11;
    const dataEnd = dataAt + dataSize;
    if (dataEnd > view.byteLength) break;
    if (tagType === 18) {
      try {
        const state = { offset: dataAt };
        const eventName = readAmf0(view, state, dataEnd);
        const metadata = readAmf0(view, state, dataEnd);
        if (eventName === "onMetaData" && metadata && typeof metadata === "object") return metadata;
      } catch { /* malformed or unsupported script tag */ }
    }
    offset = dataEnd + 4;
  }
  return null;
}

async function fetchLimited(url, byteLimit, signal, options = {}) {
  if (options.fetchLimited) return options.fetchLimited(url, byteLimit);
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${byteLimit - 1}` }, credentials: "include", cache: "no-store", signal
  });
  if (!(response.ok || response.status === 206)) throw new Error(`HTTP ${response.status}`);
  if (!response.body) return (await response.arrayBuffer()).slice(0, byteLimit);
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (total < byteLimit) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, byteLimit - total));
      chunks.push(take); total += take.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; }
  return result.buffer;
}

export async function getFlvInfo(url, signal, options = {}) {
  const buffer = await fetchLimited(url, FLV_HEAD_BYTES, signal, options);
  const metadata = parseFlvMetadata(buffer);
  const duration = Number(metadata?.duration);
  const finiteDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
  return { duration: finiteDuration, streamType: finiteDuration ? "vod" : "live", bytesRead: buffer.byteLength };
}

export function streamGroupKey(rawUrl) {
  const url = new URL(rawUrl);
  const slash = url.pathname.lastIndexOf("/");
  return `stream:${url.origin}${url.pathname.slice(0, slash + 1)}`;
}

// A number of CDNs place the manifest and its signed segments in different
// subdirectories while keeping the same host and first path namespace.
export function mediaRootKey(rawUrl) {
  const url = new URL(rawUrl);
  const firstSegment = url.pathname.split("/").filter(Boolean)[0] ?? "";
  return `media-root:${url.origin}/${firstSegment}`;
}

export function youkuPlaylistGroupKey(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/\.m3u8$/i.test(url.pathname) && !/\/playlist\/m3u8$/i.test(url.pathname)) return null;
  const vid = youkuVideoId(rawUrl);
  if (!vid) return null;
  // Audio/video tracks, qualities and refreshed signatures retain the same
  // Youku video id even when their CDN host and path are different.
  return `youku:${vid}`;
}

export function youkuVideoId(rawUrl) {
  try {
    const vid = new URL(rawUrl).searchParams.get("vid")?.trim();
    return vid ? vid.replace(/=+$/g, "") : null;
  } catch { return null; }
}

export function segmentEndSeconds(rawUrl) {
  const url = new URL(rawUrl);
  const end = Number(url.searchParams.get("end"));
  if (!Number.isFinite(end)) return null;
  // Tencent and similar players express segment timeline positions in ms.
  return end >= 1000 ? end / 1000 : end;
}

export function inferTencentM3u8(rawUrl, fromTencentPage = false) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const knownCdn = isTencentMediaHost(url.hostname) && /\/svp_[^/]+\//i.test(url.pathname);
  if (!knownCdn && !(fromTencentPage && isIndexedTs(url))) return null;
  const playlistPath = url.pathname.replace(/(\.f\d+)\.\d+\.ts$/i, "$1.ts.m3u8");
  if (playlistPath === url.pathname) return null;
  // Tencent prefixes equivalent CDN/quality routes with values such as
  // 016_, 015_, or 010_. They all resolve to the same canonical playlist.
  url.pathname = playlistPath.replace(/\/\d+_([^/]+)$/i, "/$1");
  const version = url.searchParams.get("ver");
  url.search = "";
  if (version) url.searchParams.set("ver", version);
  return url.href;
}

export function isTencentSvpSegment(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  return isTencentMediaHost(url.hostname) && /\/svp_[^/]+\//i.test(url.pathname) && /\.ts$/i.test(url.pathname);
}

export function isTencentIndexedSegment(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  return isIndexedTs(url);
}

export function tencentVideoGroupKey(rawUrl, fromTencentPage = false) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!fromTencentPage && !isTencentMediaHost(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const signedIndex = segments.findIndex((segment) => segment.startsWith("B_"));
  if (signedIndex < 0) return null;
  return `tencent:${url.origin}/${segments.slice(0, signedIndex + 1).join("/")}`;
}

function isTencentMediaHost(hostname) {
  return /(?:^|\.)(?:gtimg|qq)\.com$/i.test(hostname);
}

function isIndexedTs(url) {
  return /\.ts$/i.test(url.pathname) && url.searchParams.has("index") && url.searchParams.has("start");
}

export function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let duration = 0;
  const variants = [];
  const segments = [];
  const hasEndList = lines.includes("#EXT-X-ENDLIST");
  const isMediaPlaylist = lines.some((line) =>
    line.startsWith("#EXTINF:") ||
    line.startsWith("#EXT-X-TARGETDURATION:") ||
    line.startsWith("#EXT-X-MEDIA-SEQUENCE:") ||
    line.startsWith("#EXT-X-MAP:")
  );
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("#EXTINF:")) duration += Number.parseFloat(line.slice(8)) || 0;
    const mediaPlaylist = line.match(/^#EXT-X-MEDIA:.*\bURI="([^"]+)"/i)?.[1];
    if (mediaPlaylist) variants.push(new URL(mediaPlaylist, baseUrl).href);
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const next = lines.slice(i + 1).find((candidate) => !candidate.startsWith("#"));
      if (next) variants.push(new URL(next, baseUrl).href);
    }
    const uriAttribute = line.match(/^#EXT-X-(?:MAP|PART):.*\bURI="([^"]+)"/i)?.[1];
    if (uriAttribute) segments.push(new URL(uriAttribute, baseUrl).href);
    if (!line.startsWith("#") && !variants.includes(new URL(line, baseUrl).href)) {
      const childUrl = new URL(line, baseUrl).href;
      if (!/\.m3u8(?:$|[?#])/i.test(childUrl)) segments.push(childUrl);
    }
  }
  return { duration, variants: [...new Set(variants)], segments: [...new Set(segments)], hasEndList, isMediaPlaylist };
}

async function fetchText(url, signal) {
  const response = await fetch(url, { signal, credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function getM3u8Info(url, signal, options = {}, depth = 0, seen = new Set()) {
  if (depth > MAX_PLAYLIST_DEPTH || seen.has(url)) return { duration: null, streamType: null };
  seen.add(url);
  const loadText = options.fetchText ?? ((target) => fetchText(target, signal));
  const parsed = parseM3u8(await loadText(url), url);
  if (parsed.isMediaPlaylist) {
    return {
      duration: parsed.duration > 0 ? parsed.duration : null,
      streamType: parsed.hasEndList ? "vod" : "live",
      segments: parsed.segments
    };
  }
  for (const variant of parsed.variants) {
    try {
      const info = await getM3u8Info(variant, signal, options, depth + 1, seen);
      if (info.streamType != null) return {
        ...info,
        childPlaylists: [...new Set([...parsed.variants, ...(info.childPlaylists ?? [])])]
      };
    } catch { /* try the next variant */ }
  }
  return { duration: null, streamType: null, segments: [], childPlaylists: parsed.variants };
}

export async function getM3u8Duration(url, signal) {
  return (await getM3u8Info(url, signal)).duration;
}

function readType(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function findMvhd(view, start = 0, end = view.byteLength) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return null;
    if (type === "moov") return findMvhd(view, offset + header, offset + size);
    if (type === "mvhd") {
      const p = offset + header;
      const version = view.getUint8(p);
      const timescaleAt = version === 1 ? p + 20 : p + 12;
      const durationAt = version === 1 ? p + 24 : p + 16;
      if (durationAt + (version === 1 ? 8 : 4) > offset + size) return null;
      const timescale = view.getUint32(timescaleAt);
      const duration = version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
      return timescale ? duration / timescale : null;
    }
    offset += size;
  }
  return null;
}

function scanMvhd(view) {
  for (let typeAt = 4; typeAt + 24 < view.byteLength; typeAt += 1) {
    if (readType(view, typeAt) !== "mvhd") continue;
    const boxAt = typeAt - 4;
    const size = view.getUint32(boxAt);
    if (size < 28 || boxAt + size > view.byteLength) continue;
    const p = typeAt + 4;
    const version = view.getUint8(p);
    if (version !== 0 && version !== 1) continue;
    const timescaleAt = version === 1 ? p + 20 : p + 12;
    const durationAt = version === 1 ? p + 24 : p + 16;
    if (durationAt + (version === 1 ? 8 : 4) > boxAt + size) continue;
    const timescale = view.getUint32(timescaleAt);
    const duration = version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
    if (timescale > 0 && Number.isFinite(duration)) return duration / timescale;
  }
  return null;
}

async function fetchRange(url, range, signal, options = {}) {
  if (options.fetchRange) return options.fetchRange(url, range);
  const response = await fetch(url, {
    headers: { Range: range }, credentials: "include", cache: "no-store", signal
  });
  if (!(response.ok || response.status === 206)) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return { buffer, partial: response.status === 206 };
}

export async function getMp4Duration(url, signal, options = {}) {
  const head = await fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`, signal, options);
  let duration = findMvhd(new DataView(head.buffer)) ?? scanMvhd(new DataView(head.buffer));
  if (duration != null) return { duration, bytesRead: head.buffer.byteLength };
  if (!head.partial) return { duration: null, bytesRead: head.buffer.byteLength };
  const tail = await fetchRange(url, `bytes=-${HEAD_BYTES}`, signal, options);
  duration = findMvhd(new DataView(tail.buffer)) ?? scanMvhd(new DataView(tail.buffer));
  return { duration, bytesRead: head.buffer.byteLength + tail.buffer.byteLength };
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "未知";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
