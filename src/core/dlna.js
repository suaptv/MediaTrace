const XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => XML_ESCAPE[character]);
}

export function normalizeHeaders(headers = {}) {
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

export function playbackHeadersForPage(pageUrl, requestHeaders = {}) {
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

export function parseDlnaDescription(xml, location) {
  const services = xml.match(/<(?:[\w-]+:)?service\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?service>/gi) ?? [];
  const avTransport = services.find((service) => /urn:schemas-upnp-org:service:AVTransport:/i.test(xmlValue(service, "serviceType")));
  if (!avTransport) throw new Error("设备描述中没有 AVTransport 服务");
  const controlPath = xmlValue(avTransport, "controlURL");
  if (!controlPath) throw new Error("AVTransport 服务缺少 controlURL");
  const urlBase = xmlValue(xml, "URLBase");
  const base = urlBase ? new URL(urlBase, location).href : location;
  const controlURL = new URL(controlPath, base).href;
  const name = xmlValue(xml, "friendlyName") || "DLNA 设备";
  const udn = xmlValue(xml, "UDN");
  return { id: udn || controlURL, name, location, controlURL, host: new URL(controlURL).host };
}

export function mediaMimeType(item) {
  if (item.kind === "m3u8") return "application/vnd.apple.mpegurl";
  if (item.kind === "flv") return "video/x-flv";
  if (item.kind === "m4s") return "video/iso.segment";
  return "video/mp4";
}

export function buildDidlLite(item, headers = {}) {
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

export function buildSetUriEnvelope(item, headers) {
  const audioURI = item.audioUrl ? `<CurrentAudioURI>${escapeXml(item.audioUrl)}</CurrentAudioURI>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(item.url)}</CurrentURI>${audioURI}` +
    `<CurrentURIMetaData>${escapeXml(buildDidlLite(item, headers))}</CurrentURIMetaData>` +
    `</u:SetAVTransportURI></s:Body></s:Envelope>`;
}

export function buildPlayEnvelope() {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed>` +
    `</u:Play></s:Body></s:Envelope>`;
}

export function formatDlnaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function buildSeekEnvelope(seconds) {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>` +
    `<Unit>REL_TIME</Unit><Target>${formatDlnaTime(seconds)}</Target></u:Seek></s:Body></s:Envelope>`;
}

export async function seekOverHttp(device, seconds) {
  if (!device?.controlURL) throw new Error("设备缺少 AVTransport 控制地址");
  const response = await fetch(device.controlURL, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Seek"' },
    body: buildSeekEnvelope(seconds)
  });
  if (!response.ok) throw new Error("DLNA Seek failed, HTTP " + response.status);
}

export async function castOverHttp(device, item, headers = {}) {
  if (!device?.controlURL) throw new Error("设备缺少 AVTransport 控制地址");
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
