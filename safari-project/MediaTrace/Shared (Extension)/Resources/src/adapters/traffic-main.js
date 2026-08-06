(() => {
  if (globalThis.__mediaTraceTrafficInstalled) return;
  Object.defineProperty(globalThis, "__mediaTraceTrafficInstalled", { value: true });

  const publish = (url, contentType = "", source = "page-network") => {
    if (typeof url !== "string" || !url || url.startsWith("blob:") || url.startsWith("data:")) return;
    try {
      postMessage({ type: "MEDIATRACE_NETWORK_URL", url: new URL(url, location.href).href, contentType, source }, "*");
    } catch { /* malformed or unsupported URL */ }
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
})();
