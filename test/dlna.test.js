import test from "node:test";
import assert from "node:assert/strict";
import { buildDidlLite, buildSetUriEnvelope, normalizeHeaders, parseDlnaDescription, playbackHeadersForPage } from "../src/core/dlna.js";

test("embeds receiver-specific HTTP headers in DIDL-Lite", () => {
  const xml = buildDidlLite({ url: "https://cdn.test/v.m3u8?a=1&b=2", kind: "m3u8", domain: "cdn.test" }, {
    Referer: "https://site.test/", Cookie: "sid=a&b", Accept: "ignored"
  });
  assert.match(xml, /xmlns:mt="urn:mediatrace:metadata:1"/);
  assert.match(xml, /<mt:Header name="Referer">https:\/\/site\.test\/<\/mt:Header>/);
  assert.match(xml, /sid=a&amp;b/);
  assert.doesNotMatch(xml, /Accept/);
});

test("escapes nested DIDL metadata in SOAP envelope", () => {
  const xml = buildSetUriEnvelope({ url: "https://cdn.test/v.mp4?a=1&b=2", kind: "mp4" }, {});
  assert.match(xml, /CurrentURI>https:\/\/cdn\.test\/v\.mp4\?a=1&amp;b=2/);
  assert.match(xml, /&lt;DIDL-Lite/);
});

test("places a paired audio track beside CurrentURI", () => {
  const xml = buildSetUriEnvelope({ url: "https://cdn.test/video.m4s?a=1&b=2", audioUrl: "https://cdn.test/audio.m4s?a=3&b=4", kind: "m4s" }, {});
  assert.match(xml, /<CurrentURI>https:\/\/cdn\.test\/video\.m4s\?a=1&amp;b=2<\/CurrentURI><CurrentAudioURI>https:\/\/cdn\.test\/audio\.m4s\?a=3&amp;b=4<\/CurrentAudioURI>/);
});

test("only forwards playback-relevant headers", () => {
  assert.deepEqual(normalizeHeaders({ origin: "x", Range: "bytes=0-1", authorization: "Bearer x", "user-agent": "UA" }), {
    Origin: "x", Authorization: "Bearer x", "User-Agent": "UA"
  });
});

test("canonicalizes and deduplicates header names case-insensitively", () => {
  assert.deepEqual(normalizeHeaders({ referer: "old", Referer: "new", COOKIE: "sid=1" }), {
    Referer: "new", Cookie: "sid=1"
  });
});

test("adds MGTV root referer and origin for DLNA playback", () => {
  assert.deepEqual(playbackHeadersForPage("https://www.mgtv.com/b/894696/24537154.html?_source_=D"), {
    Referer: "https://www.mgtv.com/", Origin: "https://www.mgtv.com"
  });
});

test("lets captured request headers override MGTV defaults", () => {
  assert.deepEqual(playbackHeadersForPage("https://www.mgtv.com/b/1/2.html", {
    referer: "https://www.mgtv.com/", "user-agent": "Safari"
  }), { Referer: "https://www.mgtv.com/", Origin: "https://www.mgtv.com", "User-Agent": "Safari" });
});

test("adds Bilibili root referer and origin for DASH playback", () => {
  assert.deepEqual(playbackHeadersForPage("https://www.bilibili.com/video/BV1bB3Q6tEhE/"), {
    Referer: "https://www.bilibili.com/", Origin: "https://www.bilibili.com"
  });
});

test("resolves AVTransport control URL from a device description", () => {
  const xml = `<?xml version="1.0"?><root><URLBase>http://192.168.0.112:9030/</URLBase><device>
    <friendlyName>客厅播放器</friendlyName><UDN>uuid:renderer-1</UDN><serviceList><service>
    <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
    <controlURL>/upnp/control/AVTransport</controlURL></service></serviceList></device></root>`;
  assert.deepEqual(parseDlnaDescription(xml, "http://192.168.0.112:9030/description.xml"), {
    id: "uuid:renderer-1", name: "客厅播放器",
    location: "http://192.168.0.112:9030/description.xml",
    controlURL: "http://192.168.0.112:9030/upnp/control/AVTransport",
    host: "192.168.0.112:9030"
  });
});
