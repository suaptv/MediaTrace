(() => {
  const RESPONSE_ENDPOINT = /\/lapi\/live\/(?:getH5PlayV1|gateway\/web)\//i;
  const MEDIA_URL = /https?:\/\/[^\s"'\\]+/g;
  const emitted = new Set();

  function mediaType(url, hint = "") {
    const value = `${url} ${hint}`.toLowerCase();
    if (/\.m3u8(?:$|[?#])|hls/.test(value)) return "application/vnd.apple.mpegurl";
    if (/\.flv(?:$|[?#])|rtmp|flv/.test(value)) return "video/x-flv";
    if (/\.mp4(?:$|[?#])/.test(value)) return "video/mp4";
    return "";
  }

  function emit(rawUrl, hint = "") {
    if (typeof rawUrl !== "string") return;
    const url = rawUrl.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    let normalized;
    try { normalized = new URL(url, location.href).href; } catch { return; }
    const contentType = mediaType(normalized, hint);
    if (!contentType || emitted.has(normalized)) return;
    emitted.add(normalized);
    postMessage({ type: "MEDIATRACE_DOUYU_MEDIA", url: normalized, contentType }, location.origin);
  }

  function join(base, path) {
    if (typeof base !== "string" || typeof path !== "string") return null;
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  function inspect(value, key = "", visited = new WeakSet()) {
    if (typeof value === "string") {
      for (const match of value.match(MEDIA_URL) ?? []) emit(match, key);
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    const pairs = [
      ["rtmp_url", "rtmp_live"], ["flv_url", "flv_live"],
      ["hls_url", "hls_live"], ["base_url", "stream_name"]
    ];
    for (const [baseKey, liveKey] of pairs) {
      const combined = join(value[baseKey], value[liveKey]);
      if (combined) emit(combined, `${baseKey} ${liveKey}`);
    }
    for (const [childKey, child] of Object.entries(value)) inspect(child, childKey, visited);
  }

  function inspectText(text) {
    if (typeof text !== "string" || !text) return;
    try { inspect(JSON.parse(text)); } catch { inspect(text); }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
    const promise = originalFetch.apply(this, args);
    if (RESPONSE_ENDPOINT.test(requestUrl)) {
      promise.then((response) => response.clone().text().then(inspectText).catch(() => {})).catch(() => {});
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__streamLensDouyuUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (RESPONSE_ENDPOINT.test(this.__streamLensDouyuUrl ?? "")) {
      this.addEventListener("loadend", () => {
        try {
          if (this.responseType === "json") inspect(this.response);
          else if (this.responseType === "" || this.responseType === "text") inspectText(this.responseText);
        } catch { /* protected or unreadable response */ }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };
})();
