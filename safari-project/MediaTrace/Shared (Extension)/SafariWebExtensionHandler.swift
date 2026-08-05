import Foundation
import SafariServices
import Darwin
import os.log

private func stringDictionary(_ raw: Any?) -> [String: Any] {
    if let value = raw as? [String: Any] { return value }
    if let value = raw as? String, let data = value.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) { return stringDictionary(json) }
    if let data = raw as? Data, let json = try? JSONSerialization.jsonObject(with: data) { return stringDictionary(json) }
    guard let value = raw as? NSDictionary else { return [:] }
    var result: [String: Any] = [:]
    for (key, item) in value { if let key = key as? String { result[key] = item } }
    if result["scope"] == nil, let nested = result["message"] { return stringDictionary(nested) }
    return result
}

private final class DeviceDescriptionParser: NSObject, XMLParserDelegate {
    var friendlyName = "DLNA 设备"
    var udn = ""
    var urlBase = ""
    var controlURL = ""
    private var text = ""
    private var inService = false
    private var serviceType = ""
    private var serviceControlURL = ""

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String : String] = [:]) {
        text = ""
        if elementName == "service" { inService = true; serviceType = ""; serviceControlURL = "" }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if elementName == "friendlyName" { friendlyName = value }
        else if elementName == "UDN" { udn = value }
        else if elementName == "URLBase" { urlBase = value }
        else if inService && elementName == "serviceType" { serviceType = value }
        else if inService && elementName == "controlURL" { serviceControlURL = value }
        else if elementName == "service" {
            if serviceType.contains("AVTransport") { controlURL = serviceControlURL }
            inService = false
        }
        text = ""
    }
}

private enum DLNAError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

private final class AirPlayDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    static let shared = AirPlayDiscovery()
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
            throw DLNAError.message("AirPlay 设备或视频地址无效")
        }
        var endpoint = URLComponents(); endpoint.scheme = "http"; endpoint.host = host
        endpoint.port = (device["port"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 7000
        endpoint.path = "/play"
        guard let url = endpoint.url else { throw DLNAError.message("无法生成 AirPlay 播放地址") }
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
            let semaphore = DispatchSemaphore(value: 0)
            var output: Result<Int, Error> = .failure(DLNAError.message("AirPlay 没有返回 HTTP 响应"))
            URLSession.shared.dataTask(with: request) { _, response, error in
                if let error { output = .failure(error) }
                else if let response = response as? HTTPURLResponse { output = .success(response.statusCode) }
                semaphore.signal()
            }.resume()
            if semaphore.wait(timeout: .now() + 10) == .timedOut { throw DLNAError.message("AirPlay 推送超时") }
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
            if status == 401 || status == 403 { throw DLNAError.message("AirPlay 设备拒绝播放；请关闭设备密码/访问限制或先完成配对（HTTP \(status)）") }
            throw DLNAError.message("AirPlay 推送失败（HTTP \(status)）")
        }
    }
}

private final class LimitedDataReceiver: NSObject, URLSessionDataDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    private let maxBytes: Int
    private var data = Data()
    private var partial = false
    private var finished = false
    private(set) var result: Result<(Data, Bool), Error> = .failure(DLNAError.message("媒体元数据没有响应"))

    init(maxBytes: Int) { self.maxBytes = maxBytes }

    private func finish(_ value: Result<(Data, Bool), Error>) {
        guard !finished else { return }
        finished = true
        result = value
        semaphore.signal()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            finish(.failure(DLNAError.message("媒体元数据响应无效")))
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(response.statusCode) else {
            finish(.failure(DLNAError.message("HTTP \(response.statusCode)")))
            completionHandler(.cancel)
            return
        }
        partial = response.statusCode == 206
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard !finished else { return }
        let remaining = maxBytes - data.count
        if remaining > 0 { data.append(chunk.prefix(remaining)) }
        if data.count >= maxBytes {
            // A live FLV response may never finish and some CDNs ignore Range.
            // Stop immediately after the requested header bytes are available.
            finish(.success((data, partial)))
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        if let error, data.isEmpty { finish(.failure(error)) }
        else { finish(.success((data, partial))) }
    }
}

private final class DLNAService {
    static let shared = DLNAService()

    func fetchBytes(rawURL: String, range: String, headers: [String: Any], maxBytes: Int) throws -> [String: Any] {
        guard let url = URL(string: rawURL) else { throw DLNAError.message("媒体地址无效") }
        var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 4
        request.setValue(range, forHTTPHeaderField: "Range")
        let allowed = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        for (name, rawValue) in headers {
            if allowed.contains(name.lowercased()), let value = rawValue as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        let receiver = LimitedDataReceiver(maxBytes: maxBytes)
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: .ephemeral, delegate: receiver, delegateQueue: queue)
        let task = session.dataTask(with: request); task.resume()
        if receiver.semaphore.wait(timeout: .now() + 5) == .timedOut {
            task.cancel(); session.invalidateAndCancel()
            throw DLNAError.message("媒体头部读取超时")
        }
        session.finishTasksAndInvalidate()
        let (data, partial) = try receiver.result.get()
        return ["base64": data.base64EncodedString(), "partial": partial]
    }

    func fetchText(rawURL: String, headers: [String: Any]) throws -> String {
        guard let url = URL(string: rawURL) else { throw DLNAError.message("媒体地址无效") }
        var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
        let allowed = Set(["referer", "origin", "user-agent", "cookie", "authorization"])
        for (name, rawValue) in headers {
            if allowed.contains(name.lowercased()), let value = rawValue as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<String, Error> = .failure(DLNAError.message("媒体元数据没有响应"))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                result = .failure(DLNAError.message("HTTP \(response.statusCode)"))
            } else if let data, data.count <= 2 * 1024 * 1024 {
                result = .success(String(data: data, encoding: .utf8) ?? "")
            } else { result = .failure(DLNAError.message("媒体播放列表过大")) }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 8) == .timedOut { throw DLNAError.message("媒体元数据读取超时") }
        return try result.get()
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
        let socketFD = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard socketFD >= 0 else { throw DLNAError.message("无法创建 SSDP UDP Socket") }
        defer { close(socketFD) }

        var reuse: Int32 = 1
        guard setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &reuse,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw DLNAError.message("启用 SSDP 地址复用失败（errno \(errno)）")
        }
        guard setsockopt(socketFD, SOL_SOCKET, SO_REUSEPORT, &reuse,
                         socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw DLNAError.message("启用 SSDP 端口复用失败（errno \(errno)）")
        }

        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(socketFD, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        guard var multicast = multicastInterface() else {
            throw DLNAError.message("没有可用的 Wi-Fi 多播网络，请连接 Wi-Fi 并允许本地网络访问")
        }
        var interfaceIndex = if_nametoindex(multicast.name)
        guard interfaceIndex != 0 else {
            throw DLNAError.message("无法获取 Wi-Fi 接口索引（\(multicast.name)）")
        }
#if os(macOS)
        // IP_BOUND_IF is reliable on macOS, but combining it with an explicit
        // multicast interface can make iOS return EHOSTUNREACH (errno 65).
        let boundInterface = setsockopt(socketFD, IPPROTO_IP, IP_BOUND_IF,
                                        &interfaceIndex, socklen_t(MemoryLayout<UInt32>.size))
        guard boundInterface == 0 else {
            throw DLNAError.message("绑定 SSDP 到 Wi-Fi 接口失败（\(multicast.name)，errno \(errno)）")
        }
#endif
        let interfaceResult = setsockopt(socketFD, IPPROTO_IP, IP_MULTICAST_IF,
                                         &multicast.address, socklen_t(MemoryLayout<in_addr>.size))
        guard interfaceResult == 0 else {
            throw DLNAError.message("设置 SSDP 多播接口失败（\(multicast.name)，errno \(errno)）")
        }
        var multicastTTL: UInt8 = 2
        setsockopt(socketFD, IPPROTO_IP, IP_MULTICAST_TTL,
                   &multicastTTL, socklen_t(MemoryLayout<UInt8>.size))
        os_log(.default, "MediaTrace SSDP multicast interface: %{public}@", multicast.name)
        var local = sockaddr_in()
        local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        local.sin_family = sa_family_t(AF_INET)
        local.sin_port = 0
#if os(macOS)
        local.sin_addr = multicast.address
#else
        // Receive unicast SSDP replies on any local address. The outgoing
        // multicast interface is still pinned by IP_MULTICAST_IF above.
        local.sin_addr = in_addr(s_addr: INADDR_ANY)
#endif
        let bound = withUnsafePointer(to: &local) { address in
            address.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw DLNAError.message("绑定 SSDP 响应端口失败（errno \(errno)）") }
        var target = sockaddr_in()
        target.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        target.sin_family = sa_family_t(AF_INET)
        target.sin_port = in_port_t(1900).bigEndian
        inet_pton(AF_INET, "239.255.255.250", &target.sin_addr)
        let searchTargets = [
            "urn:schemas-upnp-org:device:MediaRenderer:1",
            "urn:schemas-upnp-org:service:AVTransport:1",
            "ssdp:all"
        ]
        for searchTarget in searchTargets {
            let query = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: \(searchTarget)\r\n\r\n"
            let sent = query.withCString { pointer in
                withUnsafePointer(to: &target) { address in
                    address.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        sendto(socketFD, pointer, strlen(pointer), 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                    }
                }
            }
            guard sent >= 0 else {
                let code = errno
                if code == EHOSTUNREACH {
                    throw DLNAError.message("SSDP 多播网络不可达（\(multicast.name)）；请确认本地网络权限及签名配置包含 Multicast Networking entitlement")
                }
                throw DLNAError.message("发送 SSDP 搜索失败（\(multicast.name)，errno \(code)）")
            }
        }

        var locations = Set<String>()
        var responseCount = 0
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = recv(socketFD, &buffer, buffer.count - 1, 0)
            if count <= 0 { break }
            responseCount += 1
            let response = String(decoding: buffer.prefix(count), as: UTF8.self)
            for line in response.components(separatedBy: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
                if parts.count == 2 && parts[0].lowercased() == "location" { locations.insert(parts[1].trimmingCharacters(in: .whitespaces)) }
            }
        }
        os_log(.default, "MediaTrace SSDP received %{public}d response(s), %{public}d LOCATION value(s)", responseCount, locations.count)
        return locations.compactMap(deviceDescription)
    }

    private func deviceDescription(location: String) -> [String: Any]? {
        guard let locationURL = URL(string: location) else {
            os_log(.error, "MediaTrace invalid SSDP LOCATION: %{public}@", location); return nil
        }
        guard let data = try? Data(contentsOf: locationURL) else {
            os_log(.error, "MediaTrace could not read device description: %{public}@", location); return nil
        }
        let delegate = DeviceDescriptionParser()
        let parser = XMLParser(data: data); parser.delegate = delegate
        guard parser.parse() else {
            os_log(.error, "MediaTrace invalid device XML: %{public}@", location); return nil
        }
        guard !delegate.controlURL.isEmpty else {
            os_log(.error, "MediaTrace device has no AVTransport controlURL: %{public}@", location); return nil
        }
        let base = URL(string: delegate.urlBase).flatMap { $0.scheme == nil ? nil : $0 } ?? locationURL
        guard let controlURL = URL(string: delegate.controlURL, relativeTo: base)?.absoluteURL else {
            os_log(.error, "MediaTrace invalid AVTransport controlURL: %{public}@", delegate.controlURL); return nil
        }
        return [
            "id": delegate.udn.isEmpty ? controlURL.absoluteString : delegate.udn,
            "name": delegate.friendlyName,
            "location": location,
            "controlURL": controlURL.absoluteString,
            "host": controlURL.host ?? ""
        ]
    }

    func position(device: [String: Any]) throws -> [String: Any] {
        guard let raw = device["controlURL"] as? String, let url = URL(string: raw) else {
            throw DLNAError.message("设备缺少 AVTransport 控制地址")
        }
        let content = "<u:GetPositionInfo xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:GetPositionInfo>"
        let xml = try soapData(url, action: "GetPositionInfo", body: envelope(content))
        return ["position": clockSeconds(xmlValue(xml, "RelTime")),
                "duration": clockSeconds(xmlValue(xml, "TrackDuration"))]
    }

    func seek(device: [String: Any], position: Double) throws {
        guard let raw = device["controlURL"] as? String, let url = URL(string: raw) else {
            throw DLNAError.message("设备缺少 AVTransport 控制地址")
        }
        let total = max(0, Int(position.rounded(.down)))
        let target = String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
        let content = "<u:Seek xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>\(target)</Target></u:Seek>"
        _ = try soapData(url, action: "Seek", body: envelope(content))
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

    private func soapData(_ url: URL, action: String, body: String) throws -> String {
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body.data(using: .utf8)
        request.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        request.setValue("\"urn:schemas-upnp-org:service:AVTransport:1#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<String, Error> = .failure(DLNAError.message("DLNA \(action) 没有响应"))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                result = .failure(DLNAError.message("DLNA \(action) 失败（HTTP \(response.statusCode)）"))
            } else { result = .success(String(data: data ?? Data(), encoding: .utf8) ?? "") }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 6) == .timedOut { throw DLNAError.message("DLNA \(action) 请求超时") }
        return try result.get()
    }

    private func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    func cast(device: [String: Any], item: [String: Any], headers: [String: Any]) throws {
        guard let control = device["controlURL"] as? String, let controlURL = URL(string: control),
              let mediaURL = item["url"] as? String else { throw DLNAError.message("设备或媒体地址无效") }
        let audioXML = (item["audioUrl"] as? String).map { "<CurrentAudioURI>\(escape($0))</CurrentAudioURI>" } ?? ""
        let kind = item["kind"] as? String ?? "mp4"
        let mime = kind == "m3u8" ? "application/vnd.apple.mpegurl" : kind == "flv" ? "video/x-flv" : "video/mp4"
        let headerXML = headers.compactMap { name, raw -> String? in
            guard let value = raw as? String, ["referer", "origin", "user-agent", "cookie", "authorization"].contains(name.lowercased()) else { return nil }
            return "<mt:Header name=\"\(escape(name))\">\(escape(value))</mt:Header>"
        }.joined()
        let title = escape((item["domain"] as? String) ?? "MediaTrace")
        let didl = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:mt=\"urn:mediatrace:metadata:1\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>\(title)</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:\(mime):*\">\(escape(mediaURL))</res><mt:HttpHeaders>\(headerXML)</mt:HttpHeaders></item></DIDL-Lite>"
        let setURI = envelope("<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>\(escape(mediaURL))</CurrentURI>\(audioXML)<CurrentURIMetaData>\(escape(didl))</CurrentURIMetaData></u:SetAVTransportURI>")
        try soap(controlURL, action: "SetAVTransportURI", body: setURI)
        try soap(controlURL, action: "Play", body: envelope("<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"))
    }

    private func envelope(_ body: String) -> String {
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\(body)</s:Body></s:Envelope>"
    }

    private func soap(_ url: URL, action: String, body: String) throws {
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body.data(using: .utf8)
        request.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        request.setValue("\"urn:schemas-upnp-org:service:AVTransport:1#\(action)\"", forHTTPHeaderField: "SOAPACTION")
        let semaphore = DispatchSemaphore(value: 0); var result: Result<Void, Error> = .success(())
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error { result = .failure(error) }
            else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                result = .failure(DLNAError.message("DLNA \(action) 失败（HTTP \(response.statusCode)）"))
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 10) == .timedOut { throw DLNAError.message("DLNA \(action) 请求超时") }
        try result.get()
    }
}

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let key: String
        if #available(iOS 15.0, macOS 11.0, *) { key = SFExtensionMessageKey }
        else { key = "message" }
        let message = stringDictionary(request?.userInfo?[key])
        os_log(.default, "MediaTrace native message scope=%{public}@ action=%{public}@ keys=%{public}@",
               message["scope"] as? String ?? "<missing>", message["action"] as? String ?? "<missing>",
               message.keys.sorted().joined(separator: ","))
        DispatchQueue.global(qos: .userInitiated).async {
            let payload: [String: Any]
            do {
                guard message["scope"] as? String == "dlna" else { throw DLNAError.message("不支持的原生消息") }
                switch message["action"] as? String {
                case "discover":
                    let devices = try DLNAService.shared.discover()
                    os_log(.default, "MediaTrace SSDP discovery completed: %{public}d device(s)", devices.count)
                    payload = ["ok": true, "devices": devices]
                case "discoverAirPlay":
                    let devices = AirPlayDiscovery.shared.discover()
                    os_log(.default, "MediaTrace Bonjour AirPlay discovery completed: %{public}d device(s)", devices.count)
                    payload = ["ok": true, "devices": devices]
                case "fetchText":
                    payload = ["ok": true, "text": try DLNAService.shared.fetchText(rawURL: message["url"] as? String ?? "", headers: stringDictionary(message["headers"]))]
                case "fetchBytes":
                    let maxBytes = min(max((message["maxBytes"] as? NSNumber)?.intValue ?? 1_048_576, 1), 1_048_576)
                    let value = try DLNAService.shared.fetchBytes(rawURL: message["url"] as? String ?? "", range: message["range"] as? String ?? "bytes=0-1048575", headers: stringDictionary(message["headers"]), maxBytes: maxBytes)
                    payload = ["ok": true, "base64": value["base64"] ?? "", "partial": value["partial"] ?? false]
                case "cast":
                    try DLNAService.shared.cast(device: stringDictionary(message["device"]), item: stringDictionary(message["item"]), headers: stringDictionary(message["headers"]))
                    payload = ["ok": true]
                case "position":
                    payload = ["ok": true, "positionInfo": try DLNAService.shared.position(device: stringDictionary(message["device"]))]
                case "seek":
                    try DLNAService.shared.seek(device: stringDictionary(message["device"]), position: (message["position"] as? NSNumber)?.doubleValue ?? 0)
                    payload = ["ok": true]
                default: throw DLNAError.message("未知的 DLNA 操作")
                }
            } catch {
                os_log(.error, "MediaTrace native request failed: %{public}@", error.localizedDescription)
                payload = ["ok": false, "error": error.localizedDescription]
            }
            let response = NSExtensionItem(); response.userInfo = [key: payload]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }
}
