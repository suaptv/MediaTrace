import Foundation
import Darwin

enum HostError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

final class AirPlayDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var resolving: [NetService] = []
    private var found: [String: [String: Any]] = [:]

    func discover(timeout: TimeInterval = 2.5) -> [[String: Any]] {
        resolving.removeAll(); found.removeAll()
        browser.delegate = self
        browser.searchForServices(ofType: "_airplay._tcp.", inDomain: "local.")
        RunLoop.current.run(until: Date().addingTimeInterval(timeout))
        browser.stop()
        resolving.forEach { $0.stop() }
        return found.values.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        resolving.append(service); service.delegate = self; service.resolve(withTimeout: 1.5)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard var host = sender.hostName?.trimmingCharacters(in: CharacterSet(charactersIn: ".")), !host.isEmpty else { return }
        if !host.lowercased().hasSuffix(".local") { host += ".local" }
        found[host.lowercased()] = ["id": host.lowercased(), "name": sender.name, "host": host,
                                   "port": sender.port, "serviceType": "_airplay._tcp"]
    }

    func cast(device: [String: Any], item: [String: Any], headers: [String: Any]) throws {
        guard let host = device["host"] as? String, !host.isEmpty,
              let mediaURL = item["url"] as? String, URL(string: mediaURL) != nil else {
            throw HostError.message("AirPlay 设备或视频地址无效")
        }
        var endpoint = URLComponents(); endpoint.scheme = "http"; endpoint.host = host
        endpoint.port = (device["port"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 7000
        endpoint.path = "/play"
        guard let url = endpoint.url else { throw HostError.message("无法生成 AirPlay 播放地址") }
        let allowed = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        let forwarded = headers.reduce(into: [String: String]()) { result, pair in
            if allowed.contains(pair.key.lowercased()), let value = pair.value as? String { result[pair.key] = value }
        }
        let sessionID = UUID().uuidString
        func send(_ data: Data, contentType: String) throws -> Int {
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = data
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(sessionID, forHTTPHeaderField: "X-Apple-Session-ID")
            request.setValue("MediaControl/1.0", forHTTPHeaderField: "User-Agent")
            var output: Result<Int, Error> = .failure(HostError.message("AirPlay 没有返回 HTTP 响应"))
            let semaphore = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { _, response, error in
                if let error { output = .failure(error) }
                else if let response = response as? HTTPURLResponse { output = .success(response.statusCode) }
                semaphore.signal()
            }.resume()
            if semaphore.wait(timeout: .now() + 10) == .timedOut { throw HostError.message("AirPlay 推送超时") }
            return try output.get()
        }
        let plist: [String: Any] = ["Content-Location": mediaURL, "Start-Position": 0.0,
                                   "MediaTrace-Headers": forwarded]
        let binary = try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0)
        var status = try send(binary, contentType: "application/x-apple-binary-plist")
        if [400, 403, 415].contains(status) {
            let encodedHeaders = (try? JSONSerialization.data(withJSONObject: forwarded).base64EncodedString()) ?? ""
            let text = "Content-Location: \(mediaURL)\r\nStart-Position: 0.000000\r\nMediaTrace-Headers: \(encodedHeaders)\r\n"
            status = try send(Data(text.utf8), contentType: "text/parameters")
        }
        guard (200..<300).contains(status) else {
            if status == 401 || status == 403 { throw HostError.message("AirPlay 设备拒绝播放；请关闭设备密码/访问限制或先完成配对（HTTP \(status)）") }
            throw HostError.message("AirPlay 推送失败（HTTP \(status)）")
        }
    }
}

final class DeviceXMLParser: NSObject, XMLParserDelegate {
    var name = "DLNA 设备", udn = "", urlBase = "", controlPath = ""
    private var text = "", serviceType = "", serviceControlPath = ""
    private var inService = false

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        text = ""
        if elementName == "service" { inService = true; serviceType = ""; serviceControlPath = "" }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if elementName == "friendlyName" { name = value }
        else if elementName == "UDN" { udn = value }
        else if elementName == "URLBase" { urlBase = value }
        else if inService && elementName == "serviceType" { serviceType = value }
        else if inService && elementName == "controlURL" { serviceControlPath = value }
        else if elementName == "service" {
            if serviceType.contains("AVTransport") { controlPath = serviceControlPath }
            inService = false
        }
        text = ""
    }
}

final class DLNAHost {
    func fetchBytes(rawURL: String, range: String, headers: [String: Any], maxBytes: Int) throws -> [String: Any] {
        guard let url = URL(string: rawURL) else { throw HostError.message("媒体地址无效") }
        var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(range, forHTTPHeaderField: "Range")
        let allowed = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        for (name, rawValue) in headers {
            if allowed.contains(name.lowercased()), let value = rawValue as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        var output: Result<(Data, Bool), Error> = .failure(HostError.message("媒体元数据没有响应")); let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { output = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                output = .failure(HostError.message("HTTP \(response.statusCode)"))
            } else if let data, data.count <= maxBytes {
                output = .success((data, (response as? HTTPURLResponse)?.statusCode == 206))
            } else { output = .failure(HostError.message("媒体元数据超过读取上限")) }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 8) == .timedOut { throw HostError.message("媒体元数据读取超时") }
        let (data, partial) = try output.get()
        return ["base64": data.base64EncodedString(), "partial": partial]
    }

    func fetchText(rawURL: String, headers: [String: Any]) throws -> String {
        guard let url = URL(string: rawURL) else { throw HostError.message("媒体地址无效") }
        var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
        let allowed = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        for (name, rawValue) in headers {
            if allowed.contains(name.lowercased()), let value = rawValue as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        var output: Result<String, Error> = .failure(HostError.message("媒体元数据没有响应")); let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { output = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                output = .failure(HostError.message("HTTP \(response.statusCode)"))
            } else if let data, data.count <= 2 * 1024 * 1024 {
                output = .success(String(data: data, encoding: .utf8) ?? "")
            } else { output = .failure(HostError.message("媒体播放列表过大")) }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 8) == .timedOut { throw HostError.message("媒体元数据读取超时") }
        return try output.get()
    }

    private func multicastInterface() -> (name: String, address: in_addr)? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }
        var candidates: [(name: String, address: in_addr)] = []
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            defer { current = interface.pointee.ifa_next }
            guard let address = interface.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET) else { continue }
            let flags = Int32(interface.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_MULTICAST != 0, flags & IFF_LOOPBACK == 0 else { continue }
            let name = String(cString: interface.pointee.ifa_name)
            guard !name.hasPrefix("utun"), !name.hasPrefix("awdl"), !name.hasPrefix("llw") else { continue }
            let ipv4 = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
            candidates.append((name, ipv4))
        }
        return candidates.first(where: { $0.name == "en0" }) ?? candidates.first
    }

    func discover() throws -> [[String: Any]] {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { throw HostError.message("无法创建 SSDP UDP Socket") }
        defer { close(fd) }
        var reuse: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw HostError.message("启用 SSDP 地址复用失败（errno \(errno)）")
        }
        guard setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &reuse,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw HostError.message("启用 SSDP 端口复用失败（errno \(errno)）")
        }
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        guard var multicast = multicastInterface() else {
            throw HostError.message("没有可用的 Wi-Fi 多播网络，请连接 Wi-Fi")
        }
        // Do not use IP_BOUND_IF here. On macOS systems with active utun
        // interfaces it can make multicast sendto() fail with EHOSTUNREACH
        // even though en0 has a valid LAN address. IP_MULTICAST_IF plus the
        // local-address bind below selects the correct outbound interface.
        guard setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &multicast.address,
                         socklen_t(MemoryLayout<in_addr>.size)) == 0 else {
            throw HostError.message("设置 SSDP 多播接口失败（\(multicast.name)，errno \(errno)）")
        }
        var ttl: UInt8 = 2
        setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, socklen_t(MemoryLayout<UInt8>.size))

        var local = sockaddr_in()
        local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        local.sin_family = sa_family_t(AF_INET)
        local.sin_port = 0
        local.sin_addr = multicast.address
        let bound = withUnsafePointer(to: &local) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw HostError.message("绑定 SSDP 响应端口失败（errno \(errno)）") }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(1900).bigEndian
        inet_pton(AF_INET, "239.255.255.250", &address.sin_addr)
        for searchTarget in ["urn:schemas-upnp-org:device:MediaRenderer:1",
                             "urn:schemas-upnp-org:service:AVTransport:1", "ssdp:all"] {
            let request = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: \(searchTarget)\r\n\r\n"
            var sent = false
            for attempt in 0..<10 {
                let result = request.withCString { bytes in
                    withUnsafePointer(to: &address) { pointer in
                        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            sendto(fd, bytes, strlen(bytes), 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                        }
                    }
                }
                if result >= 0 { sent = true; break }
                let code = errno
                guard code == EHOSTUNREACH else {
                    throw HostError.message("发送 SSDP 搜索失败（\(multicast.name)，errno \(code)）")
                }
                // macOS local-network privacy can initially reject a short-lived
                // helper before its permission alert is answered. Keep Chrome's
                // native host alive long enough for the user to grant access.
                if attempt < 9 { Thread.sleep(forTimeInterval: 1) }
            }
            guard sent else {
                throw HostError.message("Chrome 没有本地网络权限（\(multicast.name)，errno 65）；请在系统设置 → 隐私与安全性 → 本地网络中允许 Google Chrome")
            }
        }

        var locations = Set<String>()
        var bytes = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = recv(fd, &bytes, bytes.count - 1, 0)
            if count <= 0 { break }
            let response = String(decoding: bytes.prefix(count), as: UTF8.self)
            response.components(separatedBy: "\r\n").forEach { line in
                let pair = line.split(separator: ":", maxSplits: 1).map(String.init)
                if pair.count == 2 && pair[0].caseInsensitiveCompare("location") == .orderedSame {
                    locations.insert(pair[1].trimmingCharacters(in: .whitespaces))
                }
            }
        }
        return locations.compactMap(loadDevice).sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    private func loadDevice(_ location: String) -> [String: Any]? {
        guard let locationURL = URL(string: location), let data = try? synchronousData(locationURL) else { return nil }
        let info = DeviceXMLParser(), parser = XMLParser(data: data); parser.delegate = info
        guard parser.parse(), !info.controlPath.isEmpty else { return nil }
        let base = URL(string: info.urlBase).flatMap { $0.scheme == nil ? nil : $0 } ?? locationURL
        guard let controlURL = URL(string: info.controlPath, relativeTo: base)?.absoluteURL else { return nil }
        return ["id": info.udn.isEmpty ? controlURL.absoluteString : info.udn, "name": info.name,
                "location": location, "controlURL": controlURL.absoluteString, "host": controlURL.host ?? ""]
    }

    private func synchronousData(_ url: URL) throws -> Data {
        var output: Result<Data, Error> = .failure(HostError.message("设备描述读取失败"))
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: url) { data, response, error in
            if let error { output = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                output = .failure(HostError.message("设备描述返回 HTTP \(response.statusCode)"))
            } else { output = .success(data ?? Data()) }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 6) == .timedOut { throw HostError.message("设备描述读取超时") }
        return try output.get()
    }

    func position(device: [String: Any]) throws -> [String: Any] {
        guard let raw = device["controlURL"] as? String, let url = URL(string: raw) else {
            throw HostError.message("设备缺少 AVTransport 控制地址")
        }
        let content = "<u:GetPositionInfo xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:GetPositionInfo>"
        let xml = try soapData(url, "GetPositionInfo", content)
        return ["position": clockSeconds(xmlValue(xml, "RelTime")),
                "duration": clockSeconds(xmlValue(xml, "TrackDuration"))]
    }

    private func xmlValue(_ xml: String, _ tag: String) -> String {
        guard let start = xml.range(of: "<\(tag)>", options: .caseInsensitive),
              let end = xml.range(of: "</\(tag)>", options: .caseInsensitive, range: start.upperBound..<xml.endIndex) else { return "" }
        return String(xml[start.upperBound..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clockSeconds(_ value: String) -> Double {
        let parts = value.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 3 else { return 0 }
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    private func soapData(_ url: URL, _ action: String, _ content: String) throws -> String {
        let envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\(content)</s:Body></s:Envelope>"
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = Data(envelope.utf8)
        request.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        request.setValue("\"urn:schemas-upnp-org:service:AVTransport:1#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        var output: Result<String, Error> = .failure(HostError.message("DLNA \(action) 没有响应")); let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { output = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                output = .failure(HostError.message("DLNA \(action) 返回 HTTP \(response.statusCode)"))
            } else { output = .success(String(data: data ?? Data(), encoding: .utf8) ?? "") }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 6) == .timedOut { throw HostError.message("DLNA \(action) 超时") }
        return try output.get()
    }

    private func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    func cast(device: [String: Any], item: [String: Any], headers: [String: Any]) throws {
        guard let rawControlURL = device["controlURL"] as? String, let controlURL = URL(string: rawControlURL),
              let mediaURL = item["url"] as? String else { throw HostError.message("设备或媒体地址无效") }
        let audioXML = (item["audioUrl"] as? String).map { "<CurrentAudioURI>\(escape($0))</CurrentAudioURI>" } ?? ""
        let kind = item["kind"] as? String ?? "mp4"
        let mime = kind == "m3u8" ? "application/vnd.apple.mpegurl" : kind == "flv" ? "video/x-flv" : kind == "m4s" ? "video/iso.segment" : "video/mp4"
        let allowedHeaders = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        let customHeaders = headers.compactMap { key, rawValue -> String? in
            guard allowedHeaders.contains(key.lowercased()), let value = rawValue as? String, !value.isEmpty else { return nil }
            return "<mt:Header name=\"\(escape(key))\">\(escape(value))</mt:Header>"
        }.joined()
        let title = escape(item["domain"] as? String ?? "MediaTrace")
        let didl = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:mt=\"urn:mediatrace:metadata:1\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>\(title)</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:\(mime):*\">\(escape(mediaURL))</res><mt:HttpHeaders>\(customHeaders)</mt:HttpHeaders></item></DIDL-Lite>"
        try soap(controlURL, "SetAVTransportURI", "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>\(escape(mediaURL))</CurrentURI>\(audioXML)<CurrentURIMetaData>\(escape(didl))</CurrentURIMetaData></u:SetAVTransportURI>")
        try soap(controlURL, "Play", "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>")
    }

    private func soap(_ url: URL, _ action: String, _ content: String) throws {
        let envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\(content)</s:Body></s:Envelope>"
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = Data(envelope.utf8)
        request.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        request.setValue("\"urn:schemas-upnp-org:service:AVTransport:1#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        var output: Result<Void, Error> = .success(()); let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error { output = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                output = .failure(HostError.message("DLNA \(action) 返回 HTTP \(response.statusCode)"))
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 10) == .timedOut { throw HostError.message("DLNA \(action) 超时") }
        try output.get()
    }
}

func readMessage() -> [String: Any]? {
    let input = FileHandle.standardInput
    guard let lengthData = try? input.read(upToCount: 4), lengthData.count == 4 else { return nil }
    let length = lengthData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
    guard length > 0, length <= 16 * 1024 * 1024,
          let data = try? input.read(upToCount: Int(length)), data.count == Int(length) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func writeMessage(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    var length = UInt32(data.count).littleEndian
    let prefix = Data(bytes: &length, count: 4)
    func writeAll(_ value: Data) -> Bool {
        value.withUnsafeBytes { rawBuffer in
            guard var pointer = rawBuffer.baseAddress else { return true }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(STDOUT_FILENO, pointer, remaining)
                if count > 0 { pointer = pointer.advanced(by: count); remaining -= count; continue }
                if count < 0 && errno == EINTR { continue }
                return false
            }
            return true
        }
    }
    guard writeAll(prefix) else { return }
    _ = writeAll(data)
}

// Chrome may close the one-shot native messaging pipe when a popup disappears
// or a service worker cancels a request. A closed stdout must not abort the
// process while an HTTP/SSDP operation is finishing.
signal(SIGPIPE, SIG_IGN)
let dlna = DLNAHost()
let airplay = AirPlayDiscovery()
while let message = readMessage() {
    do {
        guard message["scope"] as? String == "dlna" else { throw HostError.message("不支持的消息范围") }
        if message["action"] as? String == "discover" { writeMessage(["ok": true, "devices": try dlna.discover()]) }
        else if message["action"] as? String == "discoverAirPlay" { writeMessage(["ok": true, "devices": airplay.discover()]) }
        else if message["action"] as? String == "fetchText" {
            writeMessage(["ok": true, "text": try dlna.fetchText(rawURL: message["url"] as? String ?? "", headers: message["headers"] as? [String: Any] ?? [:])])
        }
        else if message["action"] as? String == "fetchBytes" {
            let maxBytes = min(max((message["maxBytes"] as? NSNumber)?.intValue ?? 1_048_576, 1), 1_048_576)
            let value = try dlna.fetchBytes(rawURL: message["url"] as? String ?? "", range: message["range"] as? String ?? "bytes=0-1048575", headers: message["headers"] as? [String: Any] ?? [:], maxBytes: maxBytes)
            writeMessage(["ok": true, "base64": value["base64"] ?? "", "partial": value["partial"] ?? false])
        }
        else if message["action"] as? String == "cast" {
            try dlna.cast(device: message["device"] as? [String: Any] ?? [:], item: message["item"] as? [String: Any] ?? [:], headers: message["headers"] as? [String: Any] ?? [:])
            writeMessage(["ok": true])
        } else if message["action"] as? String == "position" {
            writeMessage(["ok": true, "positionInfo": try dlna.position(device: message["device"] as? [String: Any] ?? [:])])
        } else { throw HostError.message("未知的 DLNA 操作") }
    } catch { writeMessage(["ok": false, "error": error.localizedDescription]) }
}
