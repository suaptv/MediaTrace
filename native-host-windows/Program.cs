using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

static class Program
{
    static readonly HttpClient Http = new(new SocketsHttpHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromSeconds(10) };
    static readonly string[] AllowedHeaders = ["referer", "origin", "user-agent", "cookie", "authorization"];

    static async Task Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "--sync-extension-id")
        {
            Console.WriteLine(SyncExtensionIdentity(args[1], args[2]));
            return;
        }
        while (ReadMessage() is JsonObject message)
        {
            try { WriteMessage(await Handle(message)); }
            catch (Exception error) { WriteMessage(new JsonObject { ["ok"] = false, ["error"] = error.Message }); }
        }
    }

    static string SyncExtensionIdentity(string manifestPath, string keyPath)
    {
        using var rsa = RSA.Create(2048);
        if (File.Exists(keyPath)) rsa.ImportFromPem(File.ReadAllText(keyPath));
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(keyPath)!);
            File.WriteAllText(keyPath, rsa.ExportPkcs8PrivateKeyPem(), new UTF8Encoding(false));
        }
        var publicKey = rsa.ExportSubjectPublicKeyInfo();
        var manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject ?? throw new Exception("manifest.json 无效");
        manifest["key"] = Convert.ToBase64String(publicKey);
        File.WriteAllText(manifestPath, manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine, new UTF8Encoding(false));
        var hex = Convert.ToHexString(SHA256.HashData(publicKey)).ToLowerInvariant()[..32];
        return string.Concat(hex.Select(character => (char)('a' + Convert.ToInt32(character.ToString(), 16))));
    }

    static async Task<JsonObject> Handle(JsonObject message)
    {
        if (Text(message, "scope") != "dlna") throw new Exception("不支持的消息范围");
        var action = Text(message, "action");
        return action switch
        {
            "discover" => new JsonObject { ["ok"] = true, ["devices"] = await Discover() },
            "discoverAirPlay" => new JsonObject { ["ok"] = true, ["devices"] = new JsonArray() },
            "fetchText" => new JsonObject { ["ok"] = true, ["text"] = await FetchText(Text(message, "url"), Object(message, "headers")) },
            "fetchBytes" => await FetchBytes(message),
            "cast" => await Cast(Object(message, "device"), Object(message, "item"), Object(message, "headers")),
            "position" => new JsonObject { ["ok"] = true, ["positionInfo"] = await Position(Object(message, "device")) },
            "seek" => await Seek(Object(message, "device"), Number(message, "position")),
            _ => throw new Exception("未知的 DLNA 操作")
        };
    }

    static async Task<JsonArray> Discover()
    {
        using var udp = new UdpClient(AddressFamily.InterNetwork);
        udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        udp.Client.Bind(new IPEndPoint(IPAddress.Any, 0));
        udp.Ttl = 2;
        var endpoint = new IPEndPoint(IPAddress.Parse("239.255.255.250"), 1900);
        foreach (var target in new[] { "urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1", "ssdp:all" })
        {
            var request = Encoding.ASCII.GetBytes($"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {target}\r\n\r\n");
            await udp.SendAsync(request, endpoint);
        }
        var locations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        while (!timeout.IsCancellationRequested)
        {
            try
            {
                var packet = await udp.ReceiveAsync(timeout.Token);
                var response = Encoding.UTF8.GetString(packet.Buffer);
                foreach (var line in response.Split("\r\n"))
                    if (line.StartsWith("location:", StringComparison.OrdinalIgnoreCase)) locations.Add(line[(line.IndexOf(':') + 1)..].Trim());
            }
            catch (OperationCanceledException) { break; }
            catch (SocketException) { break; }
        }
        var devices = new JsonArray();
        foreach (var location in locations)
        {
            try { if (await LoadDevice(location) is JsonObject device) devices.Add(device); }
            catch { /* ignore malformed/non-renderer SSDP responses */ }
        }
        return devices;
    }

    static async Task<JsonObject?> LoadDevice(string location)
    {
        var xml = XDocument.Parse(await Http.GetStringAsync(location));
        var service = xml.Descendants().FirstOrDefault(node => node.Name.LocalName == "service" &&
            node.Elements().Any(child => child.Name.LocalName == "serviceType" && child.Value.Contains("AVTransport", StringComparison.OrdinalIgnoreCase)));
        var controlPath = service?.Elements().FirstOrDefault(node => node.Name.LocalName == "controlURL")?.Value.Trim();
        if (string.IsNullOrEmpty(controlPath)) return null;
        var locationUri = new Uri(location);
        var urlBase = xml.Descendants().FirstOrDefault(node => node.Name.LocalName == "URLBase")?.Value.Trim();
        var baseUri = Uri.TryCreate(urlBase, UriKind.Absolute, out var parsedBase) ? parsedBase : locationUri;
        var control = new Uri(baseUri, controlPath);
        var name = xml.Descendants().FirstOrDefault(node => node.Name.LocalName == "friendlyName")?.Value.Trim() ?? "DLNA 设备";
        var udn = xml.Descendants().FirstOrDefault(node => node.Name.LocalName == "UDN")?.Value.Trim();
        return new JsonObject { ["id"] = string.IsNullOrEmpty(udn) ? control.AbsoluteUri : udn, ["name"] = name,
            ["location"] = location, ["controlURL"] = control.AbsoluteUri, ["host"] = control.Authority };
    }

    static HttpRequestMessage Request(HttpMethod method, string url, JsonObject headers, string? range = null)
    {
        var request = new HttpRequestMessage(method, url);
        if (range != null) request.Headers.TryAddWithoutValidation("Range", range);
        foreach (var pair in headers)
            if (AllowedHeaders.Contains(pair.Key, StringComparer.OrdinalIgnoreCase) && pair.Value is JsonValue value)
                request.Headers.TryAddWithoutValidation(pair.Key, value.ToString());
        return request;
    }

    static async Task<string> FetchText(string url, JsonObject headers)
    {
        using var response = await Http.SendAsync(Request(HttpMethod.Get, url, headers), HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var memory = new MemoryStream();
        await CopyLimited(stream, memory, 2 * 1024 * 1024);
        return Encoding.UTF8.GetString(memory.ToArray());
    }

    static async Task<JsonObject> FetchBytes(JsonObject message)
    {
        var limit = Math.Clamp((int)Number(message, "maxBytes", 1_048_576), 1, 1_048_576);
        using var response = await Http.SendAsync(Request(HttpMethod.Get, Text(message, "url"), Object(message, "headers"), Text(message, "range", "bytes=0-1048575")), HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var memory = new MemoryStream();
        await CopyLimited(stream, memory, limit);
        return new JsonObject { ["ok"] = true, ["base64"] = Convert.ToBase64String(memory.ToArray()), ["partial"] = response.StatusCode == HttpStatusCode.PartialContent };
    }

    static async Task CopyLimited(Stream input, Stream output, int limit)
    {
        var buffer = new byte[16 * 1024]; var remaining = limit;
        while (remaining > 0)
        {
            var count = await input.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)));
            if (count == 0) break;
            await output.WriteAsync(buffer.AsMemory(0, count)); remaining -= count;
        }
    }

    static async Task<JsonObject> Cast(JsonObject device, JsonObject item, JsonObject headers)
    {
        var mediaUrl = Text(item, "url");
        var kind = Text(item, "kind", "mp4");
        var mime = kind switch { "m3u8" => "application/vnd.apple.mpegurl", "flv" => "video/x-flv", "m4s" => "video/iso.segment", _ => "video/mp4" };
        var customHeaders = string.Join("", headers.Where(pair => AllowedHeaders.Contains(pair.Key, StringComparer.OrdinalIgnoreCase))
            .Select(pair => $"<mt:Header name=\"{Escape(pair.Key)}\">{Escape(pair.Value?.ToString() ?? "")}</mt:Header>"));
        var didl = $"<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:mt=\"urn:mediatrace:metadata:1\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>{Escape(Text(item, "domain", "MediaTrace"))}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:{mime}:*\">{Escape(mediaUrl)}</res><mt:HttpHeaders>{customHeaders}</mt:HttpHeaders></item></DIDL-Lite>";
        var audio = string.IsNullOrEmpty(Text(item, "audioUrl")) ? "" : $"<CurrentAudioURI>{Escape(Text(item, "audioUrl"))}</CurrentAudioURI>";
        await Soap(device, "SetAVTransportURI", $"<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>{Escape(mediaUrl)}</CurrentURI>{audio}<CurrentURIMetaData>{Escape(didl)}</CurrentURIMetaData></u:SetAVTransportURI>");
        await Soap(device, "Play", "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>");
        return new JsonObject { ["ok"] = true };
    }

    static async Task<JsonObject> Position(JsonObject device)
    {
        var xml = await Soap(device, "GetPositionInfo", "<u:GetPositionInfo xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:GetPositionInfo>");
        var document = XDocument.Parse(xml);
        return new JsonObject { ["position"] = Clock(document, "RelTime"), ["duration"] = Clock(document, "TrackDuration") };
    }

    static async Task<JsonObject> Seek(JsonObject device, double position)
    {
        var total = Math.Max(0, (long)Math.Floor(position));
        var target = $"{total / 3600:00}:{(total % 3600) / 60:00}:{total % 60:00}";
        await Soap(device, "Seek", $"<u:Seek xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{target}</Target></u:Seek>");
        return new JsonObject { ["ok"] = true };
    }

    static async Task<string> Soap(JsonObject device, string action, string content)
    {
        var envelope = $"<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>{content}</s:Body></s:Envelope>";
        using var request = new HttpRequestMessage(HttpMethod.Post, Text(device, "controlURL"));
        request.Content = new StringContent(envelope, Encoding.UTF8, "text/xml");
        request.Headers.TryAddWithoutValidation("SOAPACTION", $"\"urn:schemas-upnp-org:service:AVTransport:1#{action}\"");
        using var response = await Http.SendAsync(request); response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    static double Clock(XDocument xml, string name)
    {
        var value = xml.Descendants().FirstOrDefault(node => node.Name.LocalName == name)?.Value;
        return TimeSpan.TryParse(value, out var time) ? time.TotalSeconds : 0;
    }

    static string Escape(string value) => WebUtility.HtmlEncode(value);
    static string Text(JsonObject value, string key, string fallback = "") => value[key]?.GetValue<string>() ?? fallback;
    static double Number(JsonObject value, string key, double fallback = 0) => value[key]?.GetValue<double>() ?? fallback;
    static JsonObject Object(JsonObject value, string key) => value[key] as JsonObject ?? new JsonObject();

    static JsonObject? ReadMessage()
    {
        var input = Console.OpenStandardInput(); Span<byte> prefix = stackalloc byte[4];
        if (!ReadExactly(input, prefix)) return null;
        var length = BitConverter.ToInt32(prefix);
        if (length <= 0 || length > 16 * 1024 * 1024) return null;
        var data = new byte[length]; if (!ReadExactly(input, data)) return null;
        return JsonNode.Parse(data) as JsonObject;
    }

    static bool ReadExactly(Stream input, Span<byte> buffer)
    {
        var offset = 0;
        while (offset < buffer.Length) { var count = input.Read(buffer[offset..]); if (count <= 0) return false; offset += count; }
        return true;
    }

    static void WriteMessage(JsonObject value)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(value); var output = Console.OpenStandardOutput();
        output.Write(BitConverter.GetBytes(data.Length)); output.Write(data); output.Flush();
    }
}
