// Generated Chromium Manifest V3 background bundle. Do not edit directly.
const HEAD_BYTES = 1024 * 1024;
// FLV onMetaData normally lives in the first script tag. Reading 64 KiB is
// enough for the header and metadata without keeping a live response open.
const FLV_HEAD_BYTES = 64 * 1024;
const MAX_PLAYLIST_DEPTH = 3;

function classifyUrl(rawUrl, contentType = "") {
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
  // Douyin mobile playback often uses an extensionless redirect endpoint.
  // iOS Safari has no webRequest access, so the content script must be able to
  // report this URL based on the playback route itself.
  if (/\/aweme\/v1\/play\/?$/i.test(pathname) && /(?:^|\.)(?:douyin|iesdouyin|amemv|snssdk)\.com$/i.test(hostname)) return "mp4";
  if (/\.flv$/i.test(pathname) || type.includes("video/x-flv")) return "flv";
  if (/\.(?:ts|cmfv|cmfa)$/i.test(pathname) || type.includes("video/mp2t") || type.includes("iso.segment")) return "stream";
  return null;
}

function inferYouTubeTrack(rawUrl) {
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

function inferM4sTrack(rawUrl, contentType = "") {
  let name = "";
  try { name = new URL(rawUrl).pathname.toLowerCase(); } catch { return "unknown"; }
  // Bilibili audio IDs (30216/30232/30280...) are authoritative. Some CDN
  // nodes incorrectly return video/mp4 for every ISO-BMFF segment.
  if (/302\d{2}\.m4s$/.test(name)) return "audio";
  const type = contentType.toLowerCase();
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (/(?:^|[\/_-])audio(?:[\/_-]|\.|$)/.test(name)) return "audio";
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
  throw new Error("Unsupported AMF type " + type);
}

function parseFlvMetadata(buffer) {
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
  if (!(response.ok || response.status === 206)) throw new Error("HTTP " + response.status);
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

async function getFlvInfo(url, signal, options = {}) {
  const buffer = await fetchLimited(url, FLV_HEAD_BYTES, signal, options);
  const metadata = parseFlvMetadata(buffer);
  const duration = Number(metadata?.duration);
  const finiteDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
  return { duration: finiteDuration, streamType: finiteDuration ? "vod" : "live", bytesRead: buffer.byteLength };
}

function streamGroupKey(rawUrl) {
  const url = new URL(rawUrl);
  const slash = url.pathname.lastIndexOf("/");
  return `stream:${url.origin}${url.pathname.slice(0, slash + 1)}`;
}

// A number of CDNs place the manifest and its signed segments in different
// subdirectories while keeping the same host and first path namespace.
function mediaRootKey(rawUrl) {
  const url = new URL(rawUrl);
  const firstSegment = url.pathname.split("/").filter(Boolean)[0] ?? "";
  return `media-root:${url.origin}/${firstSegment}`;
}

function youkuPlaylistGroupKey(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/\.m3u8$/i.test(url.pathname) && !/\/playlist\/m3u8$/i.test(url.pathname)) return null;
  const vid = youkuVideoId(rawUrl);
  if (!vid) return null;
  // Audio/video tracks, qualities and refreshed signatures retain the same
  // Youku video id even when their CDN host and path are different.
  return `youku:${vid}`;
}

function youkuVideoId(rawUrl) {
  try {
    const vid = new URL(rawUrl).searchParams.get("vid")?.trim();
    return vid ? vid.replace(/=+$/g, "") : null;
  } catch { return null; }
}

function segmentEndSeconds(rawUrl) {
  const url = new URL(rawUrl);
  const end = Number(url.searchParams.get("end"));
  if (!Number.isFinite(end)) return null;
  // Tencent and similar players express segment timeline positions in ms.
  return end >= 1000 ? end / 1000 : end;
}

function inferTencentM3u8(rawUrl, fromTencentPage = false) {
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

function isTencentSvpSegment(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  return isTencentMediaHost(url.hostname) && /\/svp_[^/]+\//i.test(url.pathname) && /\.ts$/i.test(url.pathname);
}

function isTencentIndexedSegment(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  return isIndexedTs(url);
}

function tencentVideoGroupKey(rawUrl, fromTencentPage = false) {
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

function parseM3u8(text, baseUrl) {
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
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.text();
}

async function getM3u8Info(url, signal, options = {}, depth = 0, seen = new Set()) {
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

async function getM3u8Duration(url, signal) {
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
  if (!(response.ok || response.status === 206)) throw new Error("HTTP " + response.status);
  const buffer = await response.arrayBuffer();
  return { buffer, partial: response.status === 206 };
}

async function getMp4Duration(url, signal, options = {}) {
  const head = await fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`, signal, options);
  let duration = findMvhd(new DataView(head.buffer)) ?? scanMvhd(new DataView(head.buffer));
  if (duration != null) return { duration, bytesRead: head.buffer.byteLength };
  if (!head.partial) return { duration: null, bytesRead: head.buffer.byteLength };
  const tail = await fetchRange(url, `bytes=-${HEAD_BYTES}`, signal, options);
  duration = findMvhd(new DataView(tail.buffer)) ?? scanMvhd(new DataView(tail.buffer));
  return { duration, bytesRead: head.buffer.byteLength + tail.buffer.byteLength };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "\u672a\u77e5";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => XML_ESCAPE[character]);
}

function normalizeHeaders(headers = {}) {
  const canonicalNames = new Map([
    ["referer", "Referer"], ["origin", "Origin"], ["user-agent", "User-Agent"],
    ["cookie", "Cookie"], ["authorization", "Authorization"]
  ]);
  return Object.entries(headers).reduce((result, [name, value]) => {
    const canonicalName = canonicalNames.get(name.toLowerCase());
    if (canonicalName && typeof value === "string" && value) result[canonicalName] = value;
    return result;
  }, {});
}

function playbackHeadersForPage(pageUrl, requestHeaders = {}) {
  let defaults = {};
  try {
    const page = new URL(pageUrl);
    defaults = { Referer: page.href, Origin: page.origin };
    if (/(?:^|\.)mgtv\.com$/i.test(page.hostname)) {
      defaults = { Referer: "https://www.mgtv.com/", Origin: "https://www.mgtv.com" };
    } else if (/(?:^|\.)bilibili\.com$/i.test(page.hostname)) {
      defaults = { Referer: "https://www.bilibili.com/", Origin: "https://www.bilibili.com" };
    }
  } catch { /* page URL may be unavailable for a restored tab */ }
  return normalizeHeaders({ ...defaults, ...requestHeaders });
}

function decodeXmlText(value = "") {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity.toLowerCase().startsWith("&#x");
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  }).trim();
}

function xmlValue(xml, localName) {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localName}>`, "i"));
  return decodeXmlText(match?.[1]?.replace(/<[^>]+>/g, "") ?? "");
}

function parseDlnaDescription(xml, location) {
  const services = xml.match(/<(?:[\w-]+:)?service\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?service>/gi) ?? [];
  const avTransport = services.find((service) => /urn:schemas-upnp-org:service:AVTransport:/i.test(xmlValue(service, "serviceType")));
  if (!avTransport) throw new Error("\u8bbe\u5907\u63cf\u8ff0\u4e2d\u6ca1\u6709 AVTransport \u670d\u52a1");
  const controlPath = xmlValue(avTransport, "controlURL");
  if (!controlPath) throw new Error("AVTransport \u670d\u52a1\u7f3a\u5c11 controlURL");
  const urlBase = xmlValue(xml, "URLBase");
  const base = urlBase ? new URL(urlBase, location).href : location;
  const controlURL = new URL(controlPath, base).href;
  const name = xmlValue(xml, "friendlyName") || "DLNA \u8bbe\u5907";
  const udn = xmlValue(xml, "UDN");
  return { id: udn || controlURL, name, location, controlURL, host: new URL(controlURL).host };
}

function mediaMimeType(item) {
  if (item.kind === "m3u8") return "application/vnd.apple.mpegurl";
  if (item.kind === "flv") return "video/x-flv";
  if (item.kind === "m4s") return "video/iso.segment";
  return "video/mp4";
}

function buildDidlLite(item, headers = {}) {
  const customHeaders = Object.entries(normalizeHeaders(headers)).map(([name, value]) =>
    `<mt:Header name="${escapeXml(name)}">${escapeXml(value)}</mt:Header>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:mt="urn:mediatrace:metadata:1">` +
    `<item id="0" parentID="0" restricted="1"><dc:title>${escapeXml(item.title || item.domain || "MediaTrace")}</dc:title>` +
    `<upnp:class>object.item.videoItem</upnp:class>` +
    `<res protocolInfo="http-get:*:${mediaMimeType(item)}:*">${escapeXml(item.url)}</res>` +
    `<mt:HttpHeaders>${customHeaders}</mt:HttpHeaders></item></DIDL-Lite>`;
}

function buildSetUriEnvelope(item, headers) {
  const audioURI = item.audioUrl ? `<CurrentAudioURI>${escapeXml(item.audioUrl)}</CurrentAudioURI>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(item.url)}</CurrentURI>${audioURI}` +
    `<CurrentURIMetaData>${escapeXml(buildDidlLite(item, headers))}</CurrentURIMetaData>` +
    `</u:SetAVTransportURI></s:Body></s:Envelope>`;
}

function buildPlayEnvelope() {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed>` +
    `</u:Play></s:Body></s:Envelope>`;
}

function formatDlnaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function buildSeekEnvelope(seconds) {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>` +
    `<Unit>REL_TIME</Unit><Target>${formatDlnaTime(seconds)}</Target></u:Seek></s:Body></s:Envelope>`;
}

async function seekOverHttp(device, seconds) {
  if (!device?.controlURL) throw new Error("\u8bbe\u5907\u7f3a\u5c11 AVTransport \u63a7\u5236\u5730\u5740");
  const response = await fetch(device.controlURL, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Seek"' },
    body: buildSeekEnvelope(seconds)
  });
  if (!response.ok) throw new Error("DLNA Seek failed, HTTP " + response.status);
}

async function castOverHttp(device, item, headers = {}) {
  if (!device?.controlURL) throw new Error("\u8bbe\u5907\u7f3a\u5c11 AVTransport \u63a7\u5236\u5730\u5740");
  const request = async (action, body) => {
    const response = await fetch(device.controlURL, {
      method: "POST",
      headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#' + action + '"' },
      body
    });
    if (!response.ok) throw new Error("DLNA " + action + " failed, HTTP " + response.status);
  };
  await request("SetAVTransportURI", buildSetUriEnvelope(item, headers));
  await request("Play", buildPlayEnvelope());
}

const api = globalThis.browser ?? globalThis.chrome;
const actionApi = api.action ?? api.browserAction;
const webRequestEnabled = globalThis.MEDIATRACE_WEB_REQUEST_ENABLED !== false;
const byTab = new Map();
const hlsTabs = new Set();
const hlsSegmentGroupsByTab = new Map();
const hlsManifestChildGroupsByTab = new Map();
const hlsMediaRootsByTab = new Map();
const hlsChildPlaylistsByTab = new Map();
const pendingM4sByTab = new Map();
const pendingM4sTimers = new Map();
const bilibiliDashMetadataByTab = new Map();
const bilibiliSsrTabs = new Set();
const pageUrlByTab = new Map();
const tencentVideoTabs = new Set();
const requestHeadersByUrl = new Map();
const autoCastDeviceByTab = new Map();
const autoCastPendingTabs = new Set();
const autoCastTimers = new Map();
const autoCastInFlightTabs = new Set();
const dlnaSeekStateByTab = new Map();
const hydratedTabs = new Set();
const tabOperationQueues = new Map();
const NATIVE_APP_ID = "app.mediatrace";
const MAX_ITEMS = 150;
const METADATA_TIMEOUT_MS = 6000;
// The HLS manifest normally arrives before its fMP4 fragments. A short grace
// period only covers request-event reordering without delaying DASH discovery.
const M4S_CLASSIFY_DELAY_MS = 250;
const BILIBILI_M4S_SETTLE_DELAY_MS = 900;
let enabled = false;

async function readDetectionPreference() {
  const fallback = { detectionPreference: null, detectionEnabled: null };
  const local = await api.storage.local.get(fallback).catch(() => fallback);
  const synced = api.storage.sync
    ? await api.storage.sync.get(fallback).catch(() => fallback)
    : fallback;
  const candidates = [local.detectionPreference, synced.detectionPreference]
    .filter((value) => value && typeof value.enabled === "boolean")
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (candidates.length) return Boolean(candidates[0].enabled);
  if (typeof local.detectionEnabled === "boolean") return local.detectionEnabled;
  if (typeof synced.detectionEnabled === "boolean") return synced.detectionEnabled;
  return false;
}

async function writeDetectionPreference(value) {
  const preference = { enabled: Boolean(value), updatedAt: Date.now() };
  const stored = { detectionEnabled: preference.enabled, detectionPreference: preference };
  await api.storage.local.set(stored);
  if (api.storage.sync) await api.storage.sync.set(stored).catch(() => undefined);
  return preference.enabled;
}

function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

readDetectionPreference().then((value) => {
  enabled = value;
  updateBadge();
});

function updateBadge() {
  actionApi.setBadgeText({ text: "" });
  actionApi.setBadgeBackgroundColor({ color: "#007AFF" });
}

function updateTabBadge(tabId) {
  if (tabId == null || tabId < 0) return;
  const count = byTab.get(tabId)?.size ?? 0;
  const text = enabled ? (count > 99 ? "99+" : String(count)) : "";
  actionApi.setBadgeText({ tabId, text });
  actionApi.setBadgeBackgroundColor({ tabId, color: "#007AFF" });
}

function storeFor(tabId) {
  if (!byTab.has(tabId)) byTab.set(tabId, new Map());
  return byTab.get(tabId);
}

function mediaStorageKey(tabId) {
  return `mediaTab:${tabId}`;
}

function reconcileHlsSegments(tabId) {
  const store = storeFor(tabId);
  const groups = new Set([...store.values()].filter((item) => item?.kind === "m3u8").map((item) => streamGroupKey(item.url)));
  const mediaRoots = new Set([...store.values()].filter((item) => item?.kind === "m3u8").map((item) => mediaRootKey(item.url)));
  const childGroups = new Set([...store.values()].filter((item) => item?.kind === "m3u8")
    .flatMap((item) => Array.isArray(item.hlsChildGroups) ? item.hlsChildGroups : []));
  const childPlaylists = new Set([...store.values()].filter((item) => item?.kind === "m3u8")
    .flatMap((item) => Array.isArray(item.hlsChildPlaylists) ? item.hlsChildPlaylists : []));
  if (groups.size) hlsSegmentGroupsByTab.set(tabId, groups);
  else hlsSegmentGroupsByTab.delete(tabId);
  if (childGroups.size) hlsManifestChildGroupsByTab.set(tabId, childGroups);
  else hlsManifestChildGroupsByTab.delete(tabId);
  if (mediaRoots.size) hlsMediaRootsByTab.set(tabId, mediaRoots);
  else hlsMediaRootsByTab.delete(tabId);
  if (childPlaylists.size) hlsChildPlaylistsByTab.set(tabId, childPlaylists);
  else hlsChildPlaylistsByTab.delete(tabId);
  for (const [key, item] of store) {
    if (item?.kind === "m3u8" && childPlaylists.has(playlistKey(item.url))) { store.delete(key); continue; }
    if (["stream", "m4s"].includes(item?.kind) && (groups.has(streamGroupKey(item.url)) || childGroups.has(streamGroupKey(item.url)) || mediaRoots.has(mediaRootKey(item.url)))) store.delete(key);
  }
}

function playlistKey(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

function registerHlsChildPlaylists(tabId, parentItem, childUrls = []) {
  const keys = hlsChildPlaylistsByTab.get(tabId) ?? new Set();
  for (const url of childUrls) {
    try { keys.add(playlistKey(url)); } catch { /* malformed playlist URI */ }
  }
  if (keys.size) hlsChildPlaylistsByTab.set(tabId, keys);
  for (const [key, item] of storeFor(tabId)) {
    if (item.id !== parentItem.id && item.kind === "m3u8" && keys.has(playlistKey(item.url))) storeFor(tabId).delete(key);
  }
  updateTabBadge(tabId);
}

function registerHlsManifestChildren(tabId, segmentUrls = []) {
  const groups = hlsManifestChildGroupsByTab.get(tabId) ?? new Set();
  for (const url of segmentUrls) {
    try { groups.add(streamGroupKey(url)); } catch { /* malformed playlist URI */ }
  }
  if (groups.size) hlsManifestChildGroupsByTab.set(tabId, groups);
  const store = storeFor(tabId);
  for (const [key, item] of store) {
    if (!["stream", "m4s"].includes(item.kind)) continue;
    try { if (groups.has(streamGroupKey(item.url))) store.delete(key); } catch { /* malformed captured URL */ }
  }
  updateTabBadge(tabId);
}

async function hydrateTab(tabId) {
  if (hydratedTabs.has(tabId)) return storeFor(tabId);
  const key = mediaStorageKey(tabId);
  const saved = (await api.storage.local.get({ [key]: [] }))?.[key];
  const entries = Array.isArray(saved) ? saved.filter((entry) => Array.isArray(entry) && entry.length === 2) : [];
  // Network listeners can capture media before the non-persistent background
  // has restored this tab. Keep those fresh entries instead of replacing them
  // with an older (often empty) storage snapshot when the popup opens.
  const live = byTab.get(tabId);
  byTab.set(tabId, new Map([...entries, ...(live ? live.entries() : [])]));
  reconcileHlsSegments(tabId);
  reconcileBilibiliDashTracks(tabId);
  hydratedTabs.add(tabId);
  return storeFor(tabId);
}

async function persistTab(tabId) {
  await api.storage.local.set({ [mediaStorageKey(tabId)]: [...storeFor(tabId).entries()] });
}

function enqueueTabOperation(tabId, operation) {
  const previous = tabOperationQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  tabOperationQueues.set(tabId, next);
  next.finally(() => { if (tabOperationQueues.get(tabId) === next) tabOperationQueues.delete(tabId); });
  return next;
}

function headersToObject(headers = []) {
  // Chromium may preserve response-header casing on Windows (Content-Type),
  // while Safari commonly returns lowercase names. Normalize here so
  // extensionless media can always be classified from its MIME type.
  return Object.fromEntries(headers.map(({ name, value }) => [String(name).toLowerCase(), value ?? ""]));
}

function requestPageOrigin(details) {
  for (const value of [details.initiator, details.documentUrl, details.originUrl]) {
    try {
      const origin = new URL(value).origin;
      if (origin !== "null") return origin;
    } catch { /* unavailable request context */ }
  }
  return null;
}

function isTencentVideoPage(rawUrl) {
  try { return /(?:^|\.)v\.qq\.com$/i.test(new URL(rawUrl).hostname); } catch { return false; }
}

function isBilibiliPage(rawUrl) {
  try { return /(?:^|\.)bilibili\.com$/i.test(new URL(rawUrl).hostname); } catch { return false; }
}

async function resolveWorkerTab(details) {
  const origin = requestPageOrigin(details);
  if (!origin) return null;
  let tabs;
  try { tabs = await api.tabs.query({}); } catch { return null; }
  const matches = tabs.filter((tab) => {
    try { return tab.id != null && new URL(tab.url).origin === origin; } catch { return false; }
  });
  if (matches.length === 1) return matches[0].id;
  const activeMatches = matches.filter((tab) => tab.active);
  return activeMatches.length === 1 ? activeMatches[0].id : null;
}

function addNetworkCandidate(details, contentType = "") {
  if (!enabled || !classifyUrl(details.url, contentType)) return;
  if (details.tabId >= 0) {
    if ([details.initiator, details.documentUrl, details.originUrl].some(isTencentVideoPage)) {
      tencentVideoTabs.add(details.tabId);
    }
    addCandidate(details.tabId, details.url, contentType, "network");
    return;
  }
  // Requests started by a page Service Worker can arrive with tabId = -1.
  // Only recover them when their initiator maps unambiguously to one page tab.
  void resolveWorkerTab(details).then((tabId) => {
    if (tabId != null) addCandidate(tabId, details.url, contentType, "worker-network");
  });
}

function clearPendingM4s(tabId) {
  const timer = pendingM4sTimers.get(tabId);
  if (timer != null) clearTimeout(timer);
  pendingM4sTimers.delete(tabId);
  pendingM4sByTab.delete(tabId);
}

function resetTab(tabId) {
  byTab.delete(tabId);
  hydratedTabs.delete(tabId);
  void api.storage.local.remove(mediaStorageKey(tabId));
  hlsTabs.delete(tabId);
  hlsSegmentGroupsByTab.delete(tabId);
  hlsManifestChildGroupsByTab.delete(tabId);
  hlsMediaRootsByTab.delete(tabId);
  hlsChildPlaylistsByTab.delete(tabId);
  clearPendingM4s(tabId);
  bilibiliDashMetadataByTab.delete(tabId);
  bilibiliSsrTabs.delete(tabId);
  dlnaSeekStateByTab.delete(tabId);
  updateTabBadge(tabId);
}

function resetAllTabs() {
  for (const timer of pendingM4sTimers.values()) clearTimeout(timer);
  pendingM4sTimers.clear();
  pendingM4sByTab.clear();
  bilibiliDashMetadataByTab.clear();
  bilibiliSsrTabs.clear();
  hlsTabs.clear();
  hlsSegmentGroupsByTab.clear();
  hlsManifestChildGroupsByTab.clear();
  hlsMediaRootsByTab.clear();
  hlsChildPlaylistsByTab.clear();
  pageUrlByTab.clear();
  tencentVideoTabs.clear();
  byTab.clear();
  hydratedTabs.clear();
  void api.storage.local.get(null).then((values) => api.storage.local.remove(
    Object.keys(values).filter((key) => key.startsWith("mediaTab:"))
  ));
  for (const timer of autoCastTimers.values()) clearTimeout(timer);
  autoCastTimers.clear();
  autoCastPendingTabs.clear();
  autoCastDeviceByTab.clear();
}

function commitCandidate(tabId, url, contentType, source, kind, requestHeaders = {}, deferEffects = false) {
  const store = storeFor(tabId);
  const youkuVid = youkuVideoId(url);
  if (youkuVid && kind !== "m3u8" && store.has(`youku:${youkuVid}`)) return;
  // Once the first playlist for a Youku vid arrives it becomes the single
  // canonical item. Remove earlier MP4/segment candidates carrying that vid.
  if (youkuVid && kind === "m3u8") {
    for (const [candidateKey, candidate] of store) {
      if (candidate.kind !== "m3u8" && youkuVideoId(candidate.url) === youkuVid) store.delete(candidateKey);
    }
  }
  const key = kind === "m3u8"
    ? youkuPlaylistGroupKey(url) ?? tencentVideoGroupKey(url, source === "tencent-ts-derived" || tencentVideoTabs.has(tabId)) ?? url
    : kind === "stream" ? streamGroupKey(url) : url;
  const existing = store.get(key);
  if (existing && kind === "stream") {
    existing.url = url;
    existing.segmentCount += 1;
    existing.detectedAt = Date.now();
    existing.duration = Math.max(existing.duration ?? 0, segmentEndSeconds(url) ?? 0) || null;
    return;
  }
  if (existing) {
    existing.requestHeaders = { ...existing.requestHeaders, ...normalizeHeaders(requestHeaders) };
    if (kind === "m4s") {
      const inferred = inferM4sTrack(url, contentType);
      if (inferred !== "unknown") existing.mediaTrack = inferred;
    } else if (kind === "youtube") {
      const inferred = inferYouTubeTrack(url);
      if (inferred !== "unknown") existing.mediaTrack = inferred;
    }
    return;
  }
  const hostname = new URL(url).hostname;
  const m4sKey = kind === "m4s" ? decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").toLowerCase() : "";
  const dashMetadata = m4sKey ? bilibiliDashMetadataByTab.get(tabId)?.get(m4sKey) : null;
  const item = {
    id: createId(), url, kind, source, domain: hostname,
    duration: kind === "stream" ? segmentEndSeconds(url) : null,
    streamType: kind === "stream" ? "live" : null,
    mediaTrack: kind === "m4s" ? inferM4sTrack(url, contentType) : kind === "youtube" ? inferYouTubeTrack(url) : null,
    resolution: dashMetadata ? { width: dashMetadata.width, height: dashMetadata.height } : null,
    qualityId: dashMetadata?.qualityId ?? null,
    qualityLabel: dashMetadata?.qualityLabel ?? null,
    frameRate: dashMetadata?.frameRate ?? null,
    codecs: dashMetadata?.codecs ?? null,
    // DASH/M4S on protected sites is validated with a small native Range
    // request so Referer/Cookie/User-Agent are not stripped by browser fetch.
    status: ["stream", "youtube"].includes(kind) ? "ready" : "idle", error: null, bytesRead: null,
    segmentCount: kind === "stream" ? 1 : null, detectedAt: Date.now(),
    requestHeaders: normalizeHeaders(requestHeaders)
  };
  store.set(key, item);
  while (store.size > MAX_ITEMS) store.delete(store.keys().next().value);
  if (!deferEffects) {
    updateTabBadge(tabId);
    maybeAutoCast(tabId, item);
  }
}

function maybeAutoCast(tabId, item) {
  if (!["m3u8", "mp4", "flv", "youtube"].includes(item.kind)) return;
  const previous = autoCastTimers.get(tabId);
  if (previous) clearTimeout(previous);
  autoCastTimers.set(tabId, setTimeout(async () => {
    autoCastTimers.delete(tabId);
    if (autoCastInFlightTabs.has(tabId)) return;
    const settings = await getDlnaSettings();
    if (!settings.dlnaAutoCastNext) return;
    const session = settings.dlnaAutoCastSessions?.[String(tabId)];
    const currentPageUrl = pageUrlByTab.get(tabId) ?? "";
    const deviceId = session?.deviceId ?? settings.dlnaAutoCastDeviceId ?? settings.dlnaSelectedDeviceId;
    if (!deviceId) return;
    if (session?.pageUrl === currentPageUrl && session?.mediaUrl === item.url) return;
    autoCastInFlightTabs.add(tabId);
    try { await castDlna({ tabId, mediaId: item.id, deviceId }); }
    catch { /* keep normal detection independent from optional auto-cast */ }
    finally { autoCastInFlightTabs.delete(tabId); }
  }, 800));
}

function flushPendingM4s(tabId) {
  pendingM4sTimers.delete(tabId);
  const pending = pendingM4sByTab.get(tabId);
  pendingM4sByTab.delete(tabId);
  if (!enabled || hlsTabs.has(tabId) || !pending) return;
  for (const candidate of pending.values()) {
    commitCandidate(tabId, candidate.url, candidate.contentType, candidate.source, "m4s", {}, true);
  }
  reconcileBilibiliDashTracks(tabId);
  const isBilibili = isBilibiliPage(pageUrlByTab.get(tabId)) || [...pending.values()].some((candidate) => {
    try { return /(?:^|\.)bilivideo\.(?:com|cn)$/i.test(new URL(candidate.url).hostname); } catch { return false; }
  });
  if (isBilibili) {
    for (const item of storeFor(tabId).values()) {
      if (item.kind === "m4s") item.status = "ready";
    }
  }
  updateTabBadge(tabId);
  void persistTab(tabId);
}

function reconcileBilibiliDashTracks(tabId) {
  const store = storeFor(tabId);
  const items = [...store.values()].filter((item) => item.kind === "m4s");
  const belongsToBilibili = isBilibiliPage(pageUrlByTab.get(tabId))
    || items.some((item) => { try { return /(?:^|\.)bilivideo\.com$/i.test(new URL(item.url).hostname); } catch { return false; } });
  if (!belongsToBilibili) return;
  const videos = items.filter((item) => item.mediaTrack === "video");
  const audios = items.filter((item) => item.mediaTrack === "audio");
  if (!videos.length || !audios.length) return;
  const audioRank = (item) => {
    const match = item.url.match(/-1-(30280|30232|30216)\.m4s/i);
    return match?.[1] === "30280" ? 3 : match?.[1] === "30232" ? 2 : match?.[1] === "30216" ? 1 : 0;
  };
  const audio = audios.sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0)
    || audioRank(b) - audioRank(a) || b.detectedAt - a.detectedAt)[0];
  for (const video of videos) {
    video.audioUrl = audio.url;
    video.audioQualityId = audio.qualityId ?? null;
    video.audioCodecs = audio.codecs ?? null;
    video.audioBackupUrls = Array.isArray(audio.backupUrls) ? audio.backupUrls : [];
    video.requestHeaders = { ...audio.requestHeaders, ...video.requestHeaders };
  }
  for (const [key, item] of store) {
    if (item.kind === "m4s" && item.mediaTrack === "audio") store.delete(key);
  }
  updateTabBadge(tabId);
}

function queueM4s(tabId, url, contentType, source) {
  let pending = pendingM4sByTab.get(tabId);
  if (!pending) {
    pending = new Map();
    pendingM4sByTab.set(tabId, pending);
  }
  const previous = pending.get(url);
  pending.set(url, {
    url,
    contentType: contentType || previous?.contentType || "",
    source: previous?.source ?? source
  });
  const isBilibili = isBilibiliPage(pageUrlByTab.get(tabId)) || (() => {
    try { return /(?:^|\.)bilivideo\.(?:com|cn)$/i.test(new URL(url).hostname); } catch { return false; }
  })();
  const existingTimer = pendingM4sTimers.get(tabId);
  if (isBilibili && existingTimer != null) clearTimeout(existingTimer);
  if (isBilibili || existingTimer == null) {
    const delay = isBilibili ? BILIBILI_M4S_SETTLE_DELAY_MS : M4S_CLASSIFY_DELAY_MS;
    pendingM4sTimers.set(tabId, setTimeout(() => flushPendingM4s(tabId), delay));
  }
}

function addCandidate(tabId, url, contentType = "", source = "network", requestHeaders = requestHeadersByUrl.get(url) ?? {}) {
  if (!enabled || tabId < 0) return;
  const kind = classifyUrl(url, contentType);
  if (!kind) return;
  const fromTencentPage = tencentVideoTabs.has(tabId) || isTencentVideoPage(pageUrlByTab.get(tabId));

  if (kind === "stream") {
    const inferredPlaylist = inferTencentM3u8(url, fromTencentPage);
    if (inferredPlaylist) {
      addCandidate(tabId, inferredPlaylist, "application/vnd.apple.mpegurl", "tencent-ts-derived");
      return;
    }
    // Tencent SVP segments are implementation details, not playable entries.
    // If an unfamiliar filename cannot be converted, keep it out of the store.
    if (isTencentSvpSegment(url) || fromTencentPage && isTencentIndexedSegment(url)) return;
    // HLS transport-stream fragments are implementation details. Once the
    // playlist for the same CDN directory is known, never add its TS files.
    if (hlsSegmentGroupsByTab.get(tabId)?.has(streamGroupKey(url)) || hlsManifestChildGroupsByTab.get(tabId)?.has(streamGroupKey(url)) || hlsMediaRootsByTab.get(tabId)?.has(mediaRootKey(url))) return;
  }

  // An M4S request may be either a standalone DASH track or an fMP4 HLS
  // fragment. Keep it outside the result store until the tab is classified.
  if (kind === "m3u8") {
    if (hlsChildPlaylistsByTab.get(tabId)?.has(playlistKey(url))) return;
    hlsTabs.add(tabId);
    clearPendingM4s(tabId);
    commitCandidate(tabId, url, contentType, source, kind, requestHeaders);
    reconcileHlsSegments(tabId);
    updateTabBadge(tabId);
    return;
  }
  if (kind === "m4s") {
    // playurlSSRData is authoritative on Bilibili. Once available, ignore
    // request-level M4S discoveries so the popup only contains logical pairs.
    if (bilibiliSsrTabs.has(tabId)) return;
    if (hlsManifestChildGroupsByTab.get(tabId)?.has(streamGroupKey(url)) || hlsMediaRootsByTab.get(tabId)?.has(mediaRootKey(url))) return;
    if (!hlsTabs.has(tabId)) queueM4s(tabId, url, contentType, source);
    return;
  }
  commitCandidate(tabId, url, contentType, source, kind, requestHeaders);
}

function rememberRequestHeaders(details) {
  const headers = normalizeHeaders(headersToObject(details.requestHeaders));
  if (!Object.keys(headers).length) return;
  requestHeadersByUrl.set(details.url, headers);
  if (requestHeadersByUrl.size > 500) requestHeadersByUrl.delete(requestHeadersByUrl.keys().next().value);
}

if (webRequestEnabled && api.webRequest) {
  try {
    api.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, { urls: ["<all_urls>"] }, ["requestHeaders", "extraHeaders"]);
  } catch {
    api.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, { urls: ["<all_urls>"] }, ["requestHeaders"]);
  }

  api.webRequest.onHeadersReceived.addListener(
    (details) => addNetworkCandidate(details, headersToObject(details.responseHeaders)["content-type"]),
    { urls: ["<all_urls>"] }, ["responseHeaders"]
  );

  // Capture requests as soon as the page starts them. This works for fetch/XHR,
  // media elements, service workers, and signed segment URLs without useful headers.
  api.webRequest.onBeforeRequest.addListener(
    (details) => addNetworkCandidate(details),
    { urls: ["<all_urls>"] }
  );
}

api.tabs.onRemoved.addListener((tabId) => {
  resetTab(tabId);
  pageUrlByTab.delete(tabId);
  tencentVideoTabs.delete(tabId);
  autoCastDeviceByTab.delete(tabId);
  autoCastPendingTabs.delete(tabId);
  const timer = autoCastTimers.get(tabId); if (timer) clearTimeout(timer);
  autoCastTimers.delete(tabId);
  void getDlnaSettings().then((settings) => {
    const sessions = { ...(settings.dlnaAutoCastSessions ?? {}) };
    delete sessions[String(tabId)];
    return api.storage.local.set({ dlnaAutoCastSessions: sessions });
  });
});
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && pageUrlByTab.get(tabId) !== info.url) {
    if (pageUrlByTab.has(tabId) && autoCastDeviceByTab.has(tabId)) autoCastPendingTabs.add(tabId);
    pageUrlByTab.set(tabId, info.url);
    resetTab(tabId);
    if (isTencentVideoPage(info.url)) tencentVideoTabs.add(tabId);
    else tencentVideoTabs.delete(tabId);
  } else if (info.status === "loading") {
    // A normal reload keeps the same URL, so URL comparison alone cannot
    // distinguish it. Clear this tab as soon as the new document starts.
    resetTab(tabId);
  }
});

async function enrich(tabId, item) {
  if (!item || item.status === "ready" || item.status === "error") return;
  if (item.status === "loading" && Date.now() - (item.loadingStartedAt ?? 0) < METADATA_TIMEOUT_MS + 1000) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  item.status = "loading"; item.error = null; item.loadingStartedAt = Date.now();
  try {
    const pageUrl = pageUrlByTab.get(tabId);
    const playbackHeaders = playbackHeadersForPage(pageUrl, item.requestHeaders);
    if (!playbackHeaders["User-Agent"] && navigator.userAgent) playbackHeaders["User-Agent"] = navigator.userAgent;
    const protectedSite = (() => {
      try { return /(?:^|\.)(?:mgtv|xiaohongshu|bilibili)\.com$/i.test(new URL(pageUrl).hostname); } catch { return false; }
    })();
    const decodeBase64 = (value) => {
      const binary = atob(value); const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    const nativeRange = async (url, range) => {
      const response = await nativeDlna({ action: "fetchBytes", url, range, headers: playbackHeaders, maxBytes: 1024 * 1024 });
      return { buffer: decodeBase64(response.base64 ?? ""), partial: Boolean(response.partial) };
    };
    if (item.kind === "m3u8") {
      const result = await getM3u8Info(item.url, controller.signal, protectedSite ? {
        fetchText: async (url) => {
          // Browser fetch APIs can suppress forbidden Referer/Origin headers.
          // Use the signed native bridge for MGTV metadata so the request sent
          // to the CDN exactly matches the site's playback requirements.
          const response = await nativeDlna({ action: "fetchText", url, headers: playbackHeaders });
          return response.text ?? "";
        }
      } : {});
      item.duration = result.duration;
      item.streamType = result.streamType;
      item.hlsChildGroups = [...new Set((result.segments ?? []).map((url) => streamGroupKey(url)))];
      item.hlsChildPlaylists = [...new Set((result.childPlaylists ?? []).map((url) => playlistKey(url)))];
      registerHlsManifestChildren(tabId, result.segments);
      registerHlsChildPlaylists(tabId, item, result.childPlaylists);
    }
    else if (item.kind === "mp4") {
      const result = await getMp4Duration(item.url, controller.signal, protectedSite ? { fetchRange: nativeRange } : {});
      item.duration = result.duration; item.bytesRead = result.bytesRead; item.streamType = "vod";
    } else if (item.kind === "flv") {
      const result = await getFlvInfo(item.url, controller.signal, protectedSite ? {
        fetchLimited: async (url, byteLimit) => (await nativeRange(url, `bytes=0-${byteLimit - 1}`)).buffer
      } : {});
      item.duration = result.duration; item.bytesRead = result.bytesRead; item.streamType = result.streamType;
    } else if (item.kind === "m4s" && protectedSite) {
      // DASH duration normally comes from the page manifest. Only validate the
      // first bytes here; downloading the complete video/audio track is wasteful.
      const result = await nativeRange(item.url, "bytes=0-65535");
      item.bytesRead = result.buffer.byteLength;
    }
    item.status = "ready";
  } catch (error) {
    item.status = "error";
    const errorName = error && error.name;
    const errorMessage = error && error.message;
    item.error = errorName === "AbortError" ? "\u5143\u6570\u636e\u8bfb\u53d6\u8d85\u65f6" : (errorMessage || String(error));
  } finally {
    clearTimeout(timeout);
    delete item.loadingStartedAt;
  }
}

async function nativeDlna(message) {
  if (!api.runtime.sendNativeMessage) throw new Error("\u5f53\u524d\u6d4f\u89c8\u5668\u6ca1\u6709\u53ef\u7528\u7684 DLNA \u539f\u751f\u6865\u63a5");
  const response = await api.runtime.sendNativeMessage(NATIVE_APP_ID, { scope: "dlna", ...message });
  if (!response || !response.ok) throw new Error((response && response.error) || "DLNA \u539f\u751f\u64cd\u4f5c\u5931\u8d25");
  return response;
}

async function getDlnaSettings() {
  return api.storage.local.get({ dlnaDevices: [], dlnaRememberDevice: true, dlnaSelectedDeviceId: null, dlnaConnectedDeviceIds: [], dlnaAutoCastNext: false, dlnaAutoCastDeviceId: null, dlnaAutoCastSessions: {},
    castDeviceType: "dlna", airplayDevices: [], airplaySelectedDeviceId: null });
}

async function saveDevices(devices, selectedId) {
  const unique = [...new Map(devices.filter((device) => device?.id && device?.controlURL).map((device) => [device.id, device])).values()];
  await api.storage.local.set({ dlnaDevices: unique, dlnaSelectedDeviceId: selectedId ?? null });
  return unique;
}

async function resolveManualDevice(input) {
  const address = input.controlURL?.trim();
  if (!address) throw new Error("\u8bf7\u8f93\u5165\u8bbe\u5907\u63cf\u8ff0\u5730\u5740\u6216 AVTransport Control URL");
  let parsed;
  try { parsed = new URL(address); } catch { throw new Error("\u8bbe\u5907\u5730\u5740\u683c\u5f0f\u4e0d\u6b63\u786e"); }
  const looksLikeDescription = /\.xml$/i.test(parsed.pathname) || /(?:description|desc|device)/i.test(parsed.pathname);
  if (!looksLikeDescription) {
    return { ...input, id: input.id || createId(), controlURL: parsed.href, host: parsed.host, manual: true };
  }
  const response = await fetch(parsed.href, { cache: "no-store" });
  if (!response.ok) throw new Error("\u8bfb\u53d6\u8bbe\u5907\u63cf\u8ff0\u5931\u8d25\uff0cHTTP " + response.status);
  const resolved = parseDlnaDescription(await response.text(), parsed.href);
  return { ...resolved, name: input.name?.trim() || resolved.name, manual: true };
}

async function discoverDlna() {
  const current = await getDlnaSettings();
  const response = await nativeDlna({ action: "discover" });
  const devices = await saveDevices([...current.dlnaDevices, ...(response.devices ?? [])], current.dlnaSelectedDeviceId);
  return { ...current, dlnaDevices: devices };
}

async function discoverAirPlay() {
  const current = await getDlnaSettings();
  const response = await nativeDlna({ action: "discoverAirPlay" });
  const discovered = Array.isArray(response.devices) ? response.devices : [];
  const devices = [...new Map([...current.airplayDevices, ...discovered].filter((device) => device?.id && device?.host)
    .map((device) => [device.id, device])).values()];
  await api.storage.local.set({ airplayDevices: devices });
  return { ...current, airplayDevices: devices };
}

async function castDlna(message) {
  const settings = await getDlnaSettings();
  const device = settings.dlnaDevices.find((candidate) => candidate.id === message.deviceId);
  const item = [...storeFor(message.tabId).values()].find((candidate) => candidate.id === message.mediaId);
  if (!device) throw new Error("\u8bf7\u9009\u62e9\u4e00\u4e2a DLNA \u8bbe\u5907");
  if (!item) throw new Error("\u89c6\u9891\u5730\u5740\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u68c0\u6d4b");
  const tabItems = [...storeFor(message.tabId).values()];
  const nearestTrack = (track) => tabItems
    .filter((candidate) => candidate.id !== item.id && candidate.mediaTrack === track && candidate.kind === item.kind)
    .sort((a, b) => Math.abs(a.detectedAt - item.detectedAt) - Math.abs(b.detectedAt - item.detectedAt))[0];
  const pairedAudio = item.mediaTrack === "video" ? nearestTrack("audio") : item.mediaTrack === "audio" ? item : null;
  const pairedVideo = item.mediaTrack === "audio" ? nearestTrack("video") : item.mediaTrack === "video" ? item : null;
  const tracksArePaired = pairedVideo && pairedAudio && Math.abs(pairedVideo.detectedAt - pairedAudio.detectedAt) <= 120_000;
  // DASH receivers expect video as CurrentURI and audio as CurrentAudioURI,
  // regardless of which track card the user clicked in the popup.
  const playbackItem = item.audioUrl ? item : tracksArePaired ? { ...pairedVideo, audioUrl: pairedAudio.url } : item;
  const pageUrl = pageUrlByTab.get(message.tabId);
  // A Bilibili DASH pair may expose authentication headers on either request.
  // Forward one canonical header set for both CurrentURI and CurrentAudioURI.
  const pairedRequestHeaders = !item.audioUrl && tracksArePaired ? {
    ...(pairedVideo.requestHeaders ?? {}),
    ...(pairedAudio.requestHeaders ?? {}),
    ...(item.requestHeaders ?? {})
  } : item.requestHeaders;
  const headers = playbackHeadersForPage(pageUrl, pairedRequestHeaders);
  if (!headers["User-Agent"] && navigator.userAgent) headers["User-Agent"] = navigator.userAgent;
  try {
    await nativeDlna({ action: "cast", device, item: playbackItem, headers });
  } catch (error) {
    if (!device.manual) throw error;
    await castOverHttp(device, playbackItem, headers);
  }
  const connectedIds = [...new Set([...(settings.dlnaConnectedDeviceIds ?? []), device.id])];
  await api.storage.local.set({
    dlnaConnectedDeviceIds: connectedIds,
    dlnaAutoCastSessions: { ...(settings.dlnaAutoCastSessions ?? {}), [String(message.tabId)]: {
      deviceId: device.id, pageUrl: pageUrlByTab.get(message.tabId) ?? "", mediaUrl: playbackItem.url
    } },
    ...(settings.dlnaAutoCastNext ? { dlnaAutoCastDeviceId: device.id } : {}),
    ...(settings.dlnaRememberDevice ? { dlnaSelectedDeviceId: device.id } : {})
  });
  autoCastDeviceByTab.set(message.tabId, device.id);
  return { ok: true, deviceId: device.id };
}

async function getDlnaPosition(tabId) {
  const settings = await getDlnaSettings();
  const session = settings.dlnaAutoCastSessions?.[String(tabId)];
  if (!session?.deviceId || session.pageUrl !== (pageUrlByTab.get(tabId) ?? "")) return { active: false };
  const device = settings.dlnaDevices.find((candidate) => candidate.id === session.deviceId);
  if (!device) return { active: false };
  const pendingSeek = dlnaSeekStateByTab.get(tabId);
  if (pendingSeek && Date.now() - pendingSeek.sentAt < 2500) {
    return { active: true, position: pendingSeek.position, seeking: true };
  }
  if (pendingSeek) dlnaSeekStateByTab.delete(tabId);
  const response = await nativeDlna({ action: "position", device });
  return { active: true, ...(response.positionInfo ?? {}) };
}

async function seekDlna(tabId, rawPosition) {
  const position = Number(rawPosition);
  if (!Number.isFinite(position) || position < 0) throw new Error("\u5feb\u8fdb\u65f6\u95f4\u65e0\u6548");
  const settings = await getDlnaSettings();
  const session = settings.dlnaAutoCastSessions?.[String(tabId)];
  if (!session?.deviceId || session.pageUrl !== (pageUrlByTab.get(tabId) ?? "")) return { active: false };
  const device = settings.dlnaDevices.find((candidate) => candidate.id === session.deviceId);
  if (!device) return { active: false };
  dlnaSeekStateByTab.set(tabId, { position, sentAt: Date.now() });
  try { await nativeDlna({ action: "seek", device, position }); }
  catch (error) {
    if (!device.manual) { dlnaSeekStateByTab.delete(tabId); throw error; }
    try { await seekOverHttp(device, position); }
    catch { dlnaSeekStateByTab.delete(tabId); throw error; }
  }
  return { active: true, position };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BILIBILI_DASH_METADATA") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId == null || tabId < 0) { sendResponse({ ok: false }); return false; }
    const entries = (Array.isArray(message.entries) ? message.entries : [])
      .filter((entry) => entry?.key);
    const metadata = new Map(entries
      .map((entry) => [String(entry.key).toLowerCase(), entry]));
    bilibiliDashMetadataByTab.set(tabId, metadata);
    if (message.source === "playurlSSRData") {
      if (!bilibiliSsrTabs.has(tabId)) {
        bilibiliSsrTabs.add(tabId);
        clearPendingM4s(tabId);
        for (const [key, item] of storeFor(tabId)) {
          if (item.kind === "m4s") storeFor(tabId).delete(key);
        }
      }
      const audio = entries.filter((entry) => entry.mediaTrack === "audio" && typeof entry.url === "string")
        .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
      const codecRank = (entry) => /^avc1/i.test(entry.codecs || "") ? 0
        : /^(?:hvc1|hev1)/i.test(entry.codecs || "") ? 1 : /^av01/i.test(entry.codecs || "") ? 2 : 3;
      const videosByQuality = new Map();
      for (const detail of entries.filter((entry) => entry.mediaTrack === "video" && typeof entry.url === "string")) {
        const qualityKey = Number(detail.qualityId) || `${detail.width}x${detail.height}`;
        const previous = videosByQuality.get(qualityKey);
        if (!previous || codecRank(detail) < codecRank(previous)
          || codecRank(detail) === codecRank(previous) && Number(detail.bandwidth || 0) > Number(previous.bandwidth || 0)) {
          videosByQuality.set(qualityKey, detail);
        }
      }
      const selectedVideos = [...videosByQuality.values()].sort((a, b) => Number(b.qualityId || 0) - Number(a.qualityId || 0));
      if (!selectedVideos.length && audio) {
        commitCandidate(tabId, audio.url, "audio/mp4", "bilibili-playurlSSRData", "m4s", {}, true);
        const audioItem = storeFor(tabId).get(audio.url);
        if (audioItem) {
          audioItem.mediaTrack = "audio";
          audioItem.status = "ready";
          audioItem.duration = Number(message.duration) > 0 ? Number(message.duration) : null;
          audioItem.qualityId = Number(audio.qualityId) || null;
          audioItem.bandwidth = Number(audio.bandwidth) || null;
          audioItem.size = Number(audio.size) || null;
          audioItem.codecs = audio.codecs || null;
          audioItem.backupUrls = Array.isArray(audio.backupUrls) ? audio.backupUrls : [];
        }
      }
      for (const detail of selectedVideos) {
        commitCandidate(tabId, detail.url, "video/mp4", "bilibili-playurlSSRData", "m4s", {}, true);
        const item = storeFor(tabId).get(detail.url);
        if (!item) continue;
        item.mediaTrack = "video";
        item.status = "ready";
        item.audioUrl = audio?.url || null;
        item.audioQualityId = Number(audio?.qualityId) || null;
        item.audioCodecs = audio?.codecs || null;
        item.duration = Number(message.duration) > 0 ? Number(message.duration) : null;
        item.bandwidth = Number(detail.bandwidth) || null;
        item.size = Number(detail.size) || null;
        item.backupUrls = Array.isArray(detail.backupUrls) ? detail.backupUrls : [];
        item.audioBackupUrls = Array.isArray(audio?.backupUrls) ? audio.backupUrls : [];
        item.resolution = Number(detail.width) > 0 && Number(detail.height) > 0
          ? { width: Number(detail.width), height: Number(detail.height) } : null;
        item.qualityId = Number(detail.qualityId) || null;
        item.qualityLabel = detail.qualityLabel || null;
        item.frameRate = detail.frameRate ?? null;
        item.codecs = detail.codecs ?? null;
      }
    }
    for (const item of storeFor(tabId).values()) {
      if (item.kind !== "m4s") continue;
      let key = "";
      try { key = decodeURIComponent(new URL(item.url).pathname.split("/").pop() ?? "").toLowerCase(); } catch { continue; }
      const detail = metadata.get(key);
      if (!detail) continue;
      if (detail.mediaTrack === "audio" || detail.mediaTrack === "video") item.mediaTrack = detail.mediaTrack;
      item.resolution = { width: Number(detail.width), height: Number(detail.height) };
      item.qualityId = Number(detail.qualityId) || null;
      item.qualityLabel = detail.qualityLabel || null;
      item.frameRate = detail.frameRate ?? null;
      item.codecs = detail.codecs ?? null;
    }
    reconcileBilibiliDashTracks(tabId);
    updateTabBadge(tabId);
    void persistTab(tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "PAGE_NAVIGATED") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId != null && tabId >= 0 && pageUrlByTab.get(tabId) !== message.url) {
      if (pageUrlByTab.has(tabId) && autoCastDeviceByTab.has(tabId)) autoCastPendingTabs.add(tabId);
      pageUrlByTab.set(tabId, message.url);
      resetTab(tabId);
      if (isTencentVideoPage(message.url)) tencentVideoTabs.add(tabId);
      else tencentVideoTabs.delete(tabId);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "DISCOVERED_URL") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId == null || tabId < 0) { sendResponse({ ok: false }); return false; }
    enqueueTabOperation(tabId, async () => {
      enabled = await readDetectionPreference();
      if (!enabled) return;
      await hydrateTab(tabId);
      addCandidate(tabId, message.url, message.contentType, message.source ?? "dom");
      await persistTab(tabId);
    }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "GET_MEDIA") {
    enqueueTabOperation(message.tabId, async () => {
      enabled = await readDetectionPreference();
      if (!enabled) return { items: [], enabled };
      await hydrateTab(message.tabId);
      const items = [...storeFor(message.tabId).values()].sort((a, b) => b.detectedAt - a.detectedAt);
      // Return captured addresses immediately. Metadata enrichment continues in
      // the background so a slow playlist/server cannot block the popup list.
      for (const item of items) void enrich(message.tabId, item).then(() => persistTab(message.tabId));
      return { items, enabled };
    }).then(sendResponse, () => sendResponse({ items: [], enabled }));
    return true;
  }
  if (message?.type === "GET_STATE") {
    sendResponse({ enabled }); return false;
  }
  if (message?.type === "SET_ENABLED") {
    enabled = Boolean(message.enabled);
    writeDetectionPreference(enabled).then(async () => {
      updateBadge();
      if (!enabled) { resetAllTabs(); await api.storage.local.set({ dlnaAutoCastSessions: {} }); }
      if (message.tabId != null) updateTabBadge(message.tabId);
      if (enabled && message.tabId != null) {
        try { await api.tabs.sendMessage(message.tabId, { type: "SCAN_PAGE" }); } catch { /* restricted page */ }
      }
      sendResponse({ enabled });
    });
    return true;
  }
  if (message?.type === "CLEAR_MEDIA") {
    resetTab(message.tabId); sendResponse({ ok: true }); return false;
  }
  if (message?.type === "GET_DLNA") {
    getDlnaSettings().then(sendResponse); return true;
  }
  if (message?.type === "GET_DLNA_POSITION") {
    const tabId = sender.tab?.id ?? message.tabId;
    getDlnaPosition(tabId).then(sendResponse, (error) => sendResponse({ active: false, error: error.message })); return true;
  }
  if (message?.type === "SEEK_DLNA") {
    const tabId = sender.tab?.id ?? message.tabId;
    seekDlna(tabId, message.position).then(sendResponse, (error) => sendResponse({ active: false, error: error.message })); return true;
  }
  if (message?.type === "DISCOVER_DLNA") {
    discoverDlna().then(sendResponse, (error) => sendResponse({ error: error.message })); return true;
  }
  if (message?.type === "DISCOVER_AIRPLAY") {
    discoverAirPlay().then(sendResponse, (error) => sendResponse({ error: error.message })); return true;
  }
  if (message?.type === "SAVE_DLNA_SETTINGS") {
    api.storage.local.set({ dlnaRememberDevice: Boolean(message.remember),
      dlnaSelectedDeviceId: message.remember ? message.selectedId ?? null : null,
      dlnaAutoCastNext: Boolean(message.autoCastNext),
      dlnaAutoCastDeviceId: message.autoCastNext ? message.activeDeviceId ?? message.selectedId ?? null : null })
      .then(() => sendResponse({ ok: true })); return true;
  }
  if (message?.type === "TRIGGER_AUTO_CAST") {
    const item = [...storeFor(message.tabId).values()]
      .filter((candidate) => ["m3u8", "mp4", "flv", "youtube"].includes(candidate.kind))
      .sort((a, b) => b.detectedAt - a.detectedAt)[0];
    if (item) maybeAutoCast(message.tabId, item);
    sendResponse({ ok: true, pending: Boolean(item) }); return false;
  }
  if (message?.type === "ADD_DLNA_DEVICE") {
    getDlnaSettings().then(async (state) => {
      const device = await resolveManualDevice(message.device ?? {});
      const devices = await saveDevices([...state.dlnaDevices, device], state.dlnaSelectedDeviceId);
      sendResponse({ devices, device });
    }).catch((error) => sendResponse({ error: error.message })); return true;
  }
  if (message?.type === "REMOVE_DLNA_DEVICE") {
    getDlnaSettings().then(async (state) => {
      const devices = await saveDevices(state.dlnaDevices.filter((device) => device.id !== message.deviceId),
        state.dlnaSelectedDeviceId === message.deviceId ? null : state.dlnaSelectedDeviceId);
      await api.storage.local.set({ dlnaConnectedDeviceIds: (state.dlnaConnectedDeviceIds ?? []).filter((id) => id !== message.deviceId) });
      const sessions = Object.fromEntries(Object.entries(state.dlnaAutoCastSessions ?? {}).filter(([, session]) => session?.deviceId !== message.deviceId));
      await api.storage.local.set({ dlnaAutoCastSessions: sessions });
      sendResponse({ devices });
    }); return true;
  }
  if (message?.type === "CAST_DLNA") {
    castDlna(message).then(sendResponse, (error) => sendResponse({ error: error.message })); return true;
  }
  return false;
});
