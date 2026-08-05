(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const seen = new Set();
  let dashScanTimer;

  function m4sFileKey(rawUrl) {
    try { return decodeURIComponent(new URL(rawUrl, location.href).pathname.split("/").pop() ?? "").toLowerCase(); } catch { return ""; }
  }

  function collectDashMetadata(value, results, visited = new Set()) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const mediaUrl = value.baseUrl ?? value.base_url;
    const width = Number(value.width); const height = Number(value.height);
    const key = typeof mediaUrl === "string" ? m4sFileKey(mediaUrl) : "";
    if (key && /\.m4s$/i.test(key) && width > 0 && height > 0) {
      results.set(key, { key, width, height, qualityId: Number(value.id) || null,
        frameRate: value.frameRate ?? value.frame_rate ?? null, codecs: value.codecs ?? null });
    }
    for (const child of Object.values(value)) collectDashMetadata(child, results, visited);
  }

  function assignedJson(scriptText) {
    const marker = scriptText.indexOf("__playinfo__");
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
    for (const script of document.scripts) {
      const text = script.textContent ?? "";
      if (!text.includes("baseUrl") && !text.includes("base_url")) continue;
      let data = null;
      try { data = script.type === "application/json" ? JSON.parse(text) : assignedJson(text); } catch { /* incomplete page JSON */ }
      collectDashMetadata(data, results);
    }
    if (!results.size) return;
    try {
      const pending = api.runtime.sendMessage({ type: "BILIBILI_DASH_METADATA", entries: [...results.values()] });
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
    let youtubeMedia = false;
    try { const parsed = new URL(url); youtubeMedia = /(?:^|\.)googlevideo\.com$/i.test(parsed.hostname) && parsed.pathname.endsWith("/videoplayback"); } catch { /* invalid URL */ }
    const declaredMedia = /mpegurl|video\/mp4|video\/x-flv/i.test(contentType);
    if (seen.has(url) || !youtubeMedia && !declaredMedia && !(/\.(?:m3u8|mp4|flv|ts|m4s|cmfv|cmfa)(?:$|[?#])/i.test(url))) return;
    seen.add(url);
    try {
      const pending = api.runtime.sendMessage({ type: "DISCOVERED_URL", url, source, contentType });
      if (pending?.catch) pending.catch(() => {});
    } catch { /* extension context may have been invalidated */ }
  }
  function scan(root = document) {
    root.querySelectorAll?.("video[src], video source[src], a[href]").forEach((node) => report(node.src || node.href));
  }
  function observeNavigation() {
    if (window !== top) return;
    let currentUrl = location.href;
    const notifyIfChanged = () => {
      if (location.href === currentUrl) return;
      currentUrl = location.href;
      seen.clear();
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
        try { video.currentTime = target; } catch { return; }
        video.dispatchEvent(new CustomEvent("mediatrace-dlna-position", { detail: { position, duration: Number(state.duration) || null } }));
      }).catch(() => {});
    } catch { /* extension context may have been invalidated */ }
  }
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "SCAN_PAGE") { scan(); return Promise.resolve({ ok: true }); }
    return undefined;
  });
  addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "MEDIATRACE_DOUYU_MEDIA") return;
    report(event.data.url, "douyu-player", event.data.contentType ?? "");
  });
  new MutationObserver((mutations) => mutations.forEach((m) => {
    m.addedNodes.forEach((node) => { if (node.nodeType === 1) { report(node.src || node.href); scan(node); if (node.tagName === "SCRIPT" || node.querySelector?.("script")) scheduleBilibiliDashScan(); } });
    if (m.type === "attributes") report(m.target.src || m.target.href);
  })).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
  observeNavigation();
  observeTraffic();
  scheduleBilibiliDashScan();
  setInterval(syncDlnaPosition, 4000);
  addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncDlnaPosition(); });
  document.addEventListener("DOMContentLoaded", () => { scan(); scheduleBilibiliDashScan(); }, { once: true });
})();
