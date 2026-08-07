(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const seen = new Set();
  let dashScanTimer;
  let lastBilibiliDashSignature = "";
  const remoteSeekUntil = new WeakMap();
  const webSeekTimers = new WeakMap();

  function m4sFileKey(rawUrl) {
    try { return decodeURIComponent(new URL(rawUrl, location.href).pathname.split("/").pop() ?? "").toLowerCase(); } catch { return ""; }
  }

  function collectDashMetadata(value, results, visited = new Set(), trackHint = null) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.dash && typeof value.dash === "object") {
      if (Array.isArray(value.dash.video)) {
        for (const track of value.dash.video) collectDashMetadata(track, results, visited, "video");
      }
      if (Array.isArray(value.dash.audio)) {
        for (const track of value.dash.audio) collectDashMetadata(track, results, visited, "audio");
      }
    }
    const mediaUrl = value.baseUrl ?? value.base_url;
    const width = Number(value.width); const height = Number(value.height);
    const key = typeof mediaUrl === "string" ? m4sFileKey(mediaUrl) : "";
    if (key && /\.m4s$/i.test(key)) {
      const mimeType = String(value.mimeType ?? value.mime_type ?? "").toLowerCase();
      const codecs = String(value.codecs ?? "").toLowerCase();
      const mediaTrack = trackHint ?? (mimeType.startsWith("audio/") || /^mp4a|^ec-3|^ac-3/.test(codecs)
        || /302\d{2}\.m4s$/i.test(key) ? "audio" : "video");
      results.set(key, { key, url: new URL(mediaUrl, location.href).href, mediaTrack, width, height,
        qualityId: Number(value.id) || null, bandwidth: Number(value.bandwidth) || 0,
        size: Number(value.size) || null,
        backupUrls: (value.backupUrl ?? value.backup_url ?? []).filter?.((url) => typeof url === "string") ?? [],
        frameRate: value.frameRate ?? value.frame_rate ?? null,
        codecs: value.codecs ?? null, mimeType: value.mimeType ?? value.mime_type ?? null });
    }
    for (const child of Object.values(value)) collectDashMetadata(child, results, visited, trackHint);
  }

  function collectQualityLabels(value, labels, visited = new Set()) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const qualities = value.accept_quality;
    const descriptions = value.accept_description;
    if (Array.isArray(qualities) && Array.isArray(descriptions)) {
      qualities.forEach((quality, index) => {
        const id = Number(quality); const label = descriptions[index];
        if (Number.isFinite(id) && typeof label === "string" && label.trim() && !labels.has(id)) labels.set(id, label.trim());
      });
    }
    if (Array.isArray(value.support_formats)) {
      for (const format of value.support_formats) {
        const id = Number(format?.quality);
        const label = format?.new_description ?? format?.description ?? format?.display_desc;
        if (Number.isFinite(id) && typeof label === "string" && label.trim() && !labels.has(id)) labels.set(id, label.trim());
      }
    }
    for (const child of Object.values(value)) collectQualityLabels(child, labels, visited);
  }

  function findDashDuration(value, visited = new Set()) {
    if (!value || typeof value !== "object" || visited.has(value)) return null;
    visited.add(value);
    if (value.dash && Array.isArray(value.dash.video) && Array.isArray(value.dash.audio)) {
      const duration = Number(value.dash.duration);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
    for (const child of Object.values(value)) {
      const duration = findDashDuration(child, visited);
      if (duration) return duration;
    }
    return null;
  }

  function assignedJson(scriptText, variableName = "__playinfo__") {
    const marker = scriptText.indexOf(variableName);
    if (marker < 0) return null;
    const start = scriptText.indexOf("{", marker >= 0 ? marker : 0);
    if (start < 0) return null;
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < scriptText.length; index += 1) {
      const character = scriptText[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try { return JSON.parse(scriptText.slice(start, index + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function scanBilibiliDashMetadata() {
    if (!/(?:^|\.)bilibili\.com$/i.test(location.hostname)) return;
    const results = new Map();
    const qualityLabels = new Map();
    let dashDuration = null;
    let source = "traffic-fallback";
    for (const script of document.scripts) {
      const text = script.textContent ?? "";
      if (!text.includes("playurlSSRData")) continue;
      const data = assignedJson(text, "playurlSSRData");
      collectQualityLabels(data, qualityLabels);
      collectDashMetadata(data, results);
      dashDuration = dashDuration ?? findDashDuration(data);
    }
    if (results.size) source = "playurlSSRData";
    for (const script of document.scripts) {
      if (results.size) break;
      const text = script.textContent ?? "";
      if (!text.includes("baseUrl") && !text.includes("base_url")) continue;
      let data = null;
      try { data = script.type === "application/json" ? JSON.parse(text) : assignedJson(text); } catch { /* incomplete page JSON */ }
      collectQualityLabels(data, qualityLabels);
      collectDashMetadata(data, results);
      dashDuration = dashDuration ?? findDashDuration(data);
    }
    if (!results.size) return;
    for (const entry of results.values()) entry.qualityLabel = qualityLabels.get(Number(entry.qualityId)) ?? null;
    const signature = `${source}|${[...results.keys()].sort().join("|")}`;
    if (signature === lastBilibiliDashSignature) return;
    lastBilibiliDashSignature = signature;
    try {
      const pending = api.runtime.sendMessage({ type: "BILIBILI_DASH_METADATA", source, duration: dashDuration, entries: [...results.values()] });
      if (pending?.catch) pending.catch(() => {});
    } catch { /* extension context may have been invalidated */ }
  }

  function scheduleBilibiliDashScan() {
    clearTimeout(dashScanTimer);
    dashScanTimer = setTimeout(scanBilibiliDashMetadata, 120);
  }
  function report(rawUrl, source = "dom", contentType = "") {
    if (!rawUrl) return;
    let url;
    try { url = new URL(rawUrl, location.href).href; } catch { return; }
    let youtubeMedia = false; let declaredByUrl = false; let douyinPlay = false;
    try {
      const parsed = new URL(url);
      youtubeMedia = /(?:^|\.)googlevideo\.com$/i.test(parsed.hostname) && parsed.pathname.endsWith("/videoplayback");
      const mime = (parsed.searchParams.get("mime_type") ?? parsed.searchParams.get("mime") ?? "").toLowerCase();
      declaredByUrl = mime === "video_mp4" || mime.startsWith("video/mp4") || mime.includes("mpegurl");
      douyinPlay = /\/aweme\/v1\/play\/?$/i.test(parsed.pathname) && /(?:^|\.)(?:douyin|iesdouyin|amemv|snssdk)\.com$/i.test(parsed.hostname);
    } catch { /* invalid URL */ }
    const declaredMedia = /mpegurl|video\/mp4|video\/x-flv/i.test(contentType);
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (seen.has(url) || !youtubeMedia && !declaredMedia && !declaredByUrl && !douyinPlay && !(/\.(?:m3u8|mp4|flv|ts|m4s|cmfv|cmfa)(?:$|[?#])/i.test(url))) return;
    seen.add(url);
    try {
      const pending = api.runtime.sendMessage({ type: "DISCOVERED_URL", url, source, contentType });
      if (pending?.catch) pending.catch(() => {});
    } catch { /* extension context may have been invalidated */ }
  }
  function scan(root = document) {
    root.querySelectorAll?.("video").forEach((video) => { report(video.currentSrc, "video-current-src"); report(video.src, "video-src"); });
    root.querySelectorAll?.("video source[src], a[href]").forEach((node) => report(node.src || node.href));
  }
  function reportPlayingVideo(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    report(video.currentSrc, "video-current-src");
    report(video.src, "video-src");
    performance.getEntriesByType?.("resource").forEach((entry) => report(entry.name, "performance-playing"));
  }
  function observeNavigation() {
    if (window !== top) return;
    let currentUrl = location.href;
    const notifyIfChanged = () => {
      if (location.href === currentUrl) return;
      currentUrl = location.href;
      seen.clear();
      lastBilibiliDashSignature = "";
      scheduleBilibiliDashScan();
      try {
        const pending = api.runtime.sendMessage({ type: "PAGE_NAVIGATED", url: currentUrl });
        if (pending?.catch) pending.catch(() => {});
      } catch { /* extension context may have been invalidated */ }
      queueMicrotask(() => scan());
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        notifyIfChanged();
        return result;
      };
    }
    addEventListener("popstate", notifyIfChanged);
    addEventListener("hashchange", notifyIfChanged);
    // Extension isolated worlds do not always observe a site's patched History
    // methods, so this lightweight check also covers framework-driven SPA routes.
    setInterval(notifyIfChanged, 250);
  }
  function observeTraffic() {
    if (typeof PerformanceObserver !== "function") return;
    const handleRecords = (records) => {
      records.getEntries().forEach((entry) => report(entry.name, "performance"));
    };
    try {
      const observer = new PerformanceObserver(handleRecords);
      observer.observe({ type: "resource", buffered: true });
    } catch {
      // Safari 15 supports the older entryTypes form, not the newer buffered
      // single-type observation options used by current Chromium/Safari.
      try {
        const observer = new PerformanceObserver(handleRecords);
        observer.observe({ entryTypes: ["resource"] });
      } catch { /* resource timing observation is unavailable */ }
    }
    performance.getEntriesByType?.("resource").forEach((entry) => report(entry.name, "performance"));
  }
  function syncDlnaPosition() {
    if (window !== top || document.visibilityState !== "visible") return;
    try {
      const pending = api.runtime.sendMessage({ type: "GET_DLNA_POSITION" });
      if (!pending?.then) return;
      pending.then((state) => {
        const position = Number(state?.position);
        if (!state?.active || !Number.isFinite(position) || position < 0) return;
        const videos = [...document.querySelectorAll("video")].filter((video) => video.readyState > 0 && Number.isFinite(video.duration));
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video || Math.abs(video.currentTime - position) < 2) return;
        const target = Math.min(position, Math.max(0, video.duration - 0.05));
        remoteSeekUntil.set(video, { position: target, until: Date.now() + 1800 });
        try { video.currentTime = target; } catch { remoteSeekUntil.delete(video); return; }
        video.dispatchEvent(new CustomEvent("mediatrace-dlna-position", { detail: { position, duration: Number(state.duration) || null } }));
      }).catch(() => {});
    } catch { /* extension context may have been invalidated */ }
  }
  function forwardWebSeek(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || window !== top || document.visibilityState !== "visible") return;
    const remote = remoteSeekUntil.get(video);
    if (remote && Date.now() < remote.until && Math.abs(video.currentTime - remote.position) < 2) return;
    if (remote && Date.now() >= remote.until) remoteSeekUntil.delete(video);
    clearTimeout(webSeekTimers.get(video));
    webSeekTimers.set(video, setTimeout(() => {
      const position = Number(video.currentTime);
      if (!Number.isFinite(position) || position < 0) return;
      try {
        const pending = api.runtime.sendMessage({ type: "SEEK_DLNA", position });
        if (pending?.catch) pending.catch(() => {});
      } catch { /* extension context may have been invalidated */ }
    }, 180));
  }
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "SCAN_PAGE") { scan(); return Promise.resolve({ ok: true }); }
    return undefined;
  });
  addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "MEDIATRACE_DOUYU_MEDIA") {
      report(event.data.url, "douyu-player", event.data.contentType ?? "");
    } else if (event.data?.type === "MEDIATRACE_NETWORK_URL") {
      report(event.data.url, event.data.source ?? "page-network", event.data.contentType ?? "");
    }
  });
  new MutationObserver((mutations) => mutations.forEach((m) => {
    m.addedNodes.forEach((node) => { if (node.nodeType === 1) { report(node.src || node.href); scan(node); if (node.tagName === "SCRIPT" || node.querySelector?.("script")) scheduleBilibiliDashScan(); } });
    if (m.type === "attributes") report(m.target.src || m.target.href);
  })).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
  observeNavigation();
  observeTraffic();
  for (const eventName of ["loadedmetadata", "play", "playing"]) document.addEventListener(eventName, reportPlayingVideo, true);
  scheduleBilibiliDashScan();
  setInterval(syncDlnaPosition, 4000);
  document.addEventListener("seeked", forwardWebSeek, true);
  addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncDlnaPosition(); });
  document.addEventListener("DOMContentLoaded", () => { scan(); scheduleBilibiliDashScan(); }, { once: true });
})();
