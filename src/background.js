import { classifyUrl, getFlvInfo, getM3u8Info, getMp4Duration, inferM4sTrack, inferTencentM3u8, inferYouTubeTrack, isTencentIndexedSegment, isTencentSvpSegment, mediaRootKey, segmentEndSeconds, streamGroupKey, tencentVideoGroupKey, youkuPlaylistGroupKey, youkuVideoId } from "./core/media.js";
import { castOverHttp, normalizeHeaders, parseDlnaDescription, playbackHeadersForPage } from "./core/dlna.js";

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
const pageUrlByTab = new Map();
const tencentVideoTabs = new Set();
const requestHeadersByUrl = new Map();
const autoCastDeviceByTab = new Map();
const autoCastPendingTabs = new Set();
const autoCastTimers = new Map();
const autoCastInFlightTabs = new Set();
const hydratedTabs = new Set();
const tabOperationQueues = new Map();
const NATIVE_APP_ID = "app.mediatrace";
const MAX_ITEMS = 150;
const METADATA_TIMEOUT_MS = 6000;
// The HLS manifest normally arrives before its fMP4 fragments. A short grace
// period only covers request-event reordering without delaying DASH discovery.
const M4S_CLASSIFY_DELAY_MS = 250;
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
  return Object.fromEntries(headers.map(({ name, value }) => [name, value ?? ""]));
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
  updateTabBadge(tabId);
}

function resetAllTabs() {
  for (const timer of pendingM4sTimers.values()) clearTimeout(timer);
  pendingM4sTimers.clear();
  pendingM4sByTab.clear();
  bilibiliDashMetadataByTab.clear();
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

function commitCandidate(tabId, url, contentType, source, kind, requestHeaders = {}) {
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
  updateTabBadge(tabId);
  maybeAutoCast(tabId, item);
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
    commitCandidate(tabId, candidate.url, candidate.contentType, candidate.source, "m4s");
  }
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
  if (!pendingM4sTimers.has(tabId)) {
    pendingM4sTimers.set(tabId, setTimeout(() => flushPendingM4s(tabId), M4S_CLASSIFY_DELAY_MS));
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
    item.error = error?.name === "AbortError" ? "元数据读取超时" : error?.message ?? String(error);
  } finally {
    clearTimeout(timeout);
    delete item.loadingStartedAt;
  }
}

async function nativeDlna(message) {
  if (!api.runtime.sendNativeMessage) throw new Error("当前浏览器没有可用的 DLNA 原生桥接");
  const response = await api.runtime.sendNativeMessage(NATIVE_APP_ID, { scope: "dlna", ...message });
  if (!response?.ok) throw new Error(response?.error || "DLNA 原生操作失败");
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
  if (!address) throw new Error("请输入设备描述地址或 AVTransport Control URL");
  let parsed;
  try { parsed = new URL(address); } catch { throw new Error("设备地址格式不正确"); }
  const looksLikeDescription = /\.xml$/i.test(parsed.pathname) || /(?:description|desc|device)/i.test(parsed.pathname);
  if (!looksLikeDescription) {
    return { ...input, id: input.id || createId(), controlURL: parsed.href, host: parsed.host, manual: true };
  }
  const response = await fetch(parsed.href, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取设备描述失败（HTTP ${response.status}）`);
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
  if (!device) throw new Error("请选择一个 DLNA 设备");
  if (!item) throw new Error("视频地址已失效，请重新检测");
  const tabItems = [...storeFor(message.tabId).values()];
  const nearestTrack = (track) => tabItems
    .filter((candidate) => candidate.id !== item.id && candidate.mediaTrack === track && candidate.kind === item.kind)
    .sort((a, b) => Math.abs(a.detectedAt - item.detectedAt) - Math.abs(b.detectedAt - item.detectedAt))[0];
  const pairedAudio = item.mediaTrack === "video" ? nearestTrack("audio") : item.mediaTrack === "audio" ? item : null;
  const pairedVideo = item.mediaTrack === "audio" ? nearestTrack("video") : item.mediaTrack === "video" ? item : null;
  const tracksArePaired = pairedVideo && pairedAudio && Math.abs(pairedVideo.detectedAt - pairedAudio.detectedAt) <= 120_000;
  // DASH receivers expect video as CurrentURI and audio as CurrentAudioURI,
  // regardless of which track card the user clicked in the popup.
  const playbackItem = tracksArePaired ? { ...pairedVideo, audioUrl: pairedAudio.url } : item;
  const pageUrl = pageUrlByTab.get(message.tabId);
  // A Bilibili DASH pair may expose authentication headers on either request.
  // Forward one canonical header set for both CurrentURI and CurrentAudioURI.
  const pairedRequestHeaders = tracksArePaired ? {
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
  const response = await nativeDlna({ action: "position", device });
  return { active: true, ...(response.positionInfo ?? {}) };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BILIBILI_DASH_METADATA") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId == null || tabId < 0) { sendResponse({ ok: false }); return false; }
    const metadata = new Map((Array.isArray(message.entries) ? message.entries : [])
      .filter((entry) => entry?.key && Number(entry.width) > 0 && Number(entry.height) > 0)
      .map((entry) => [String(entry.key).toLowerCase(), entry]));
    bilibiliDashMetadataByTab.set(tabId, metadata);
    for (const item of storeFor(tabId).values()) {
      if (item.kind !== "m4s") continue;
      let key = "";
      try { key = decodeURIComponent(new URL(item.url).pathname.split("/").pop() ?? "").toLowerCase(); } catch { continue; }
      const detail = metadata.get(key);
      if (!detail) continue;
      item.resolution = { width: Number(detail.width), height: Number(detail.height) };
      item.qualityId = Number(detail.qualityId) || null;
      item.frameRate = detail.frameRate ?? null;
      item.codecs = detail.codecs ?? null;
    }
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
