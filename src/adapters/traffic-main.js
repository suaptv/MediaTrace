(() => {
  if (globalThis.__mediaTraceTrafficInstalled) return;
  Object.defineProperty(globalThis, "__mediaTraceTrafficInstalled", { value: true });

  const publish = (url, contentType = "", source = "page-network") => {
    if (typeof url !== "string" || !url || url.startsWith("blob:") || url.startsWith("data:")) return;
    try {
      postMessage({ type: "MEDIATRACE_NETWORK_URL", url: new URL(url, location.href).href, contentType, source }, "*");
    } catch { /* malformed or unsupported URL */ }
  };

  // Bilibili also exposes the resolved DASH payload as a runtime variable.
  // The regular content script runs in an isolated world, so forward it from
  // the page's MAIN world and let the existing DASH merger process it.
  let lastBilibiliPlayinfoSignature = "";
  const publishBilibiliPlayinfo = () => {
    if (!/(?:^|\.)bilibili\.com$/i.test(location.hostname)) return;
    const playinfo = globalThis.__playinfo__ ?? globalThis.playinfo;
    if (!playinfo || typeof playinfo !== "object") return;
    const payload = playinfo.data ?? playinfo;
    const dash = payload?.dash;
    const video = Array.isArray(dash?.video) ? dash.video : [];
    const audio = Array.isArray(dash?.audio) ? dash.audio : [];
    const signature = [location.href, payload?.quality, payload?.timelength, dash?.duration,
      video.length, audio.length, video[0]?.baseUrl ?? video[0]?.base_url,
      audio[0]?.baseUrl ?? audio[0]?.base_url].join("|");
    if (!video.length && !audio.length || signature === lastBilibiliPlayinfoSignature) return;
    lastBilibiliPlayinfoSignature = signature;
    try { postMessage({ type: "MEDIATRACE_BILIBILI_PLAYINFO", data: playinfo }, "*"); }
    catch { /* the page may be replacing a temporarily non-cloneable value */ }
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function (input, init) {
      const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      publish(requestUrl, "", "page-fetch-request");
      const pending = originalFetch.call(this, input, init);
      pending.then((response) => {
        try { publish(response.url || requestUrl, response.headers.get("content-type") || "", "page-fetch-response"); }
        catch { /* opaque response */ }
      }, () => {});
      return pending;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mediaTraceRequestUrl = typeof url === "string" ? url : String(url);
    publish(this.__mediaTraceRequestUrl, "", "page-xhr-request");
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      let contentType = "";
      try { contentType = this.getResponseHeader("content-type") || ""; } catch { /* unavailable header */ }
      publish(this.responseURL || this.__mediaTraceRequestUrl, contentType, "page-xhr-response");
    }, { once: true });
    return originalSend.apply(this, args);
  };

  publishBilibiliPlayinfo();
  setInterval(publishBilibiliPlayinfo, 250);
})();
