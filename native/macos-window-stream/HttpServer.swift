import AppKit
import CryptoKit
import Darwin
import Foundation

struct HttpRequest {
  let method: String
  let path: String
  let query: [String: String]
  let headers: [String: String]
  let body: Data
}

final class SocketConnection: @unchecked Sendable {
  let fd: Int32
  private let writeLock = NSLock()
  private var closed = false

  init(fd: Int32) {
    self.fd = fd
    var one: Int32 = 1
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }

  deinit {
    close()
  }

  func close() {
    writeLock.lock()
    if !closed {
      closed = true
      Darwin.close(fd)
    }
    writeLock.unlock()
  }

  @discardableResult
  func writeAll(_ data: Data) -> Bool {
    writeLock.lock()
    defer { writeLock.unlock() }
    if closed { return false }
    return data.withUnsafeBytes { rawBuf -> Bool in
      guard let base = rawBuf.baseAddress else { return true }
      var sent = 0
      while sent < rawBuf.count {
        let n = Darwin.send(fd, base.advanced(by: sent), rawBuf.count - sent, 0)
        if n <= 0 {
          if errno == EINTR { continue }
          return false
        }
        sent += n
      }
      return true
    }
  }

  func sendHttpResponse(
    status: String,
    contentType: String,
    extraHeaders: [String: String] = [:],
    body: Data
  ) {
    var head = "HTTP/1.1 \(status)\r\n"
    head += "Content-Type: \(contentType)\r\n"
    head += "Content-Length: \(body.count)\r\n"
    head += "Cache-Control: no-store, no-transform\r\n"
    head += "Connection: close\r\n"
    for (k, v) in extraHeaders {
      head += "\(k): \(v)\r\n"
    }
    head += "\r\n"
    var packet = Data(head.utf8)
    packet.append(body)
    _ = writeAll(packet)
    close()
  }

  func sendJson<T: Encodable>(_ value: T, status: String = "200 OK") {
    let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
    sendHttpResponse(status: status, contentType: "application/json; charset=utf-8", body: data)
  }

  func readExact(_ count: Int) -> Data? {
    var buf = Data(count: count)
    var got = 0
    let ok = buf.withUnsafeMutableBytes { rawBuf -> Bool in
      guard let base = rawBuf.baseAddress else { return false }
      while got < count {
        let n = Darwin.recv(fd, base.advanced(by: got), count - got, 0)
        if n <= 0 {
          if n < 0 && errno == EINTR { continue }
          return false
        }
        got += n
      }
      return true
    }
    return ok ? buf : nil
  }

  func readHttpRequest() -> HttpRequest? {
    var raw = Data()
    var temp = [UInt8](repeating: 0, count: 4096)
    let delimiter = Data("\r\n\r\n".utf8)
    var headerEndRange: Range<Data.Index>?

    while headerEndRange == nil {
      let n = Darwin.recv(fd, &temp, temp.count, 0)
      if n <= 0 {
        if n < 0 && errno == EINTR { continue }
        return nil
      }
      raw.append(contentsOf: temp[0..<n])
      headerEndRange = raw.range(of: delimiter)
      if raw.count > 65536 { return nil }
    }

    guard let range = headerEndRange else { return nil }
    guard let headerStr = String(data: raw.subdata(in: 0..<range.lowerBound), encoding: .utf8) else {
      return nil
    }
    let lines = headerStr.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return nil }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return nil }

    let method = String(parts[0])
    let target = String(parts[1])
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      if let sep = line.firstIndex(of: ":") {
        let name = line[..<sep].trimmingCharacters(in: .whitespaces).lowercased()
        let val = line[line.index(after: sep)...].trimmingCharacters(in: .whitespaces)
        headers[name] = val
      }
    }

    var body = raw.subdata(in: range.upperBound..<raw.endIndex)
    if let lenStr = headers["content-length"], let expected = Int(lenStr), expected > body.count {
      let remaining = min(expected - body.count, 1024 * 1024)
      if let more = readExact(remaining) {
        body.append(more)
      }
    }

    let comps = URLComponents(string: "http://localhost\(target)")
    let path = comps?.path ?? target
    var query: [String: String] = [:]
    for item in comps?.queryItems ?? [] {
      query[item.name] = item.value ?? ""
    }

    return HttpRequest(method: method, path: path, query: query, headers: headers, body: body)
  }

  func sendWsFrame(opcode: UInt8, payload: Data) -> Bool {
    var frame = Data()
    frame.append(0x80 | (opcode & 0x0F))
    let len = payload.count
    if len < 126 {
      frame.append(UInt8(len))
    } else if len <= Int(UInt16.max) {
      frame.append(126)
      var be = UInt16(len).bigEndian
      withUnsafeBytes(of: &be) { frame.append(contentsOf: $0) }
    } else {
      frame.append(127)
      var be = UInt64(len).bigEndian
      withUnsafeBytes(of: &be) { frame.append(contentsOf: $0) }
    }
    frame.append(payload)
    return writeAll(frame)
  }

  func readWsMessage() -> (opcode: UInt8, payload: Data)? {
    guard let header = readExact(2) else { return nil }
    let opcode = header[0] & 0x0F
    let masked = (header[1] & 0x80) != 0
    var payloadLen = UInt64(header[1] & 0x7F)

    if payloadLen == 126 {
      guard let ext = readExact(2) else { return nil }
      payloadLen = UInt64(ext[0]) << 8 | UInt64(ext[1])
    } else if payloadLen == 127 {
      guard let ext = readExact(8) else { return nil }
      payloadLen = 0
      for b in ext { payloadLen = (payloadLen << 8) | UInt64(b) }
    }
    if payloadLen > 4 * 1024 * 1024 { return nil }

    var maskKey: [UInt8] = []
    if masked {
      guard let key = readExact(4) else { return nil }
      maskKey = Array(key)
    }

    var payload = payloadLen == 0 ? Data() : (readExact(Int(payloadLen)) ?? Data())
    if payload.count != Int(payloadLen) { return nil }
    if masked && !payload.isEmpty {
      payload.withUnsafeMutableBytes { rawBuf in
        let ptr = rawBuf.bindMemory(to: UInt8.self)
        for i in 0..<ptr.count {
          ptr[i] ^= maskKey[i & 3]
        }
      }
    }
    return (opcode, payload)
  }
}

final class WindowStreamHttpServer {
  private let listenFd: Int32
  let port: UInt16
  private let token: String?
  private let demoEnabled: Bool
  private let acceptQueue = DispatchQueue(label: "t3.window.http.accept")

  init(port: UInt16, token: String?, demoEnabled: Bool) throws {
    self.token = token
    self.demoEnabled = demoEnabled

    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    var reuse: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

    let bindRes = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bindRes == 0 else {
      let err = errno
      Darwin.close(fd)
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
    }
    guard Darwin.listen(fd, 64) == 0 else {
      let err = errno
      Darwin.close(fd)
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
    }

    var actualAddr = sockaddr_in()
    var actualLen = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &actualAddr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        _ = Darwin.getsockname(fd, $0, &actualLen)
      }
    }
    self.listenFd = fd
    self.port = UInt16(bigEndian: actualAddr.sin_port)
  }

  func start() {
    acceptQueue.async { [weak self] in
      guard let self else { return }
      while true {
        var clientAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
          $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.accept(self.listenFd, $0, &len)
          }
        }
        if clientFd < 0 {
          if errno == EINTR { continue }
          break
        }
        let conn = SocketConnection(fd: clientFd)
        DispatchQueue.global(qos: .userInteractive).async {
          self.handleConnection(conn)
        }
      }
    }
  }

  private func isAuthorized(_ req: HttpRequest) -> Bool {
    guard let expected = token, !expected.isEmpty else { return true }
    if let auth = req.headers["authorization"], auth == "Bearer \(expected)" {
      return true
    }
    if req.query["token"] == expected {
      return true
    }
    return false
  }

  private func handleConnection(_ conn: SocketConnection) {
    guard let req = conn.readHttpRequest() else {
      conn.close()
      return
    }

    if demoEnabled && req.method == "GET" && (req.path == "/" || req.path == "/index.html") {
      let html = DemoHtml.render(token: token ?? "")
      conn.sendHttpResponse(
        status: "200 OK",
        contentType: "text/html; charset=utf-8",
        body: Data(html.utf8)
      )
      return
    }

    if req.method == "GET" && req.path == "/health" {
      conn.sendJson(HealthResponse(ok: true, pid: getpid()))
      return
    }

    guard isAuthorized(req) else {
      conn.sendHttpResponse(status: "401 Unauthorized", contentType: "text/plain", body: Data("Unauthorized".utf8))
      return
    }

    if req.method == "GET" && req.path == "/windows" {
      Task {
        let list = await WindowDiscovery.shared.listTargets()
        conn.sendJson(list)
      }
      return
    }

    if req.method == "POST" && req.path == "/permissions/request" {
      let perms = WindowDiscovery.shared.requestPermissions()
      conn.sendJson(perms)
      return
    }

    if req.method == "POST" && req.path == "/permissions/open-settings" {
      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
        DispatchQueue.main.async {
          NSWorkspace.shared.open(url)
        }
      }
      conn.sendJson(WindowDiscovery.shared.permissionsStatus())
      return
    }

    // Parse /window/:id/<action> or /display/:id/<action>
    let segs = req.path.split(separator: "/").map(String.init)
    guard segs.count == 3, (segs[0] == "window" || segs[0] == "display"), let rawId = UInt32(segs[1]) else {
      conn.sendHttpResponse(status: "404 Not Found", contentType: "text/plain", body: Data("Not Found".utf8))
      return
    }
    let target: CaptureTargetKey = segs[0] == "window" ? .window(rawId) : .display(rawId)
    let action = segs[2]

    switch action {
    case "snapshot.jpg":
      Task {
        do {
          let jpeg = try await CaptureManager.shared.snapshotJpeg(for: target)
          conn.sendHttpResponse(status: "200 OK", contentType: "image/jpeg", body: jpeg)
        } catch {
          conn.sendHttpResponse(status: "404 Not Found", contentType: "text/plain", body: Data("Not Found".utf8))
        }
      }
    case "stream.avcc":
      serveAvccStream(conn: conn, target: target)
    case "stream.mjpeg":
      serveMjpegStream(conn: conn, target: target)
    case "input":
      if req.headers["upgrade"]?.lowercased() == "websocket" {
        serveInputWebSocket(conn: conn, req: req, target: target)
      } else {
        conn.sendHttpResponse(status: "426 Upgrade Required", contentType: "text/plain", body: Data("WebSocket required".utf8))
      }
    default:
      conn.sendHttpResponse(status: "404 Not Found", contentType: "text/plain", body: Data("Not Found".utf8))
    }
  }

  private func serveAvccStream(conn: SocketConnection, target: CaptureTargetKey) {
    let header =
      "HTTP/1.1 200 OK\r\n"
      + "Content-Type: application/octet-stream\r\n"
      + "Cache-Control: no-store, no-transform\r\n"
      + "X-Accel-Buffering: no\r\n"
      + "Connection: close\r\n\r\n"
    guard conn.writeAll(Data(header.utf8)) else {
      conn.close()
      return
    }

    let session = CaptureManager.shared.session(for: target)
    var subRef: StreamSubscriber?
    let sub = StreamSubscriber(
      label: "t3.avcc.sub.\(target.description)",
      maxPendingWrites: 2,
      send: { data in conn.writeAll(data) },
      onClose: {
        if let id = subRef?.id {
          session.removeAvccSubscriber(id)
        }
        conn.close()
      }
    )
    subRef = sub

    Task {
      do {
        try await session.addAvccSubscriber(sub)
        // Monitor client EOF so we clean up even if the window is completely static.
        DispatchQueue.global().async {
          var byte: UInt8 = 0
          while true {
            let n = Darwin.recv(conn.fd, &byte, 1, 0)
            if n <= 0 {
              if n < 0 && errno == EINTR { continue }
              break
            }
          }
          sub.markClosed()
          session.removeAvccSubscriber(sub.id)
          conn.close()
        }
      } catch {
        sub.markClosed()
        conn.close()
      }
    }
  }

  private func serveMjpegStream(conn: SocketConnection, target: CaptureTargetKey) {
    let header =
      "HTTP/1.1 200 OK\r\n"
      + "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
      + "Cache-Control: no-store, no-transform\r\n"
      + "X-Accel-Buffering: no\r\n"
      + "Connection: close\r\n\r\n"
    guard conn.writeAll(Data(header.utf8)) else {
      conn.close()
      return
    }

    let session = CaptureManager.shared.session(for: target)
    var subRef: StreamSubscriber?
    let sub = StreamSubscriber(
      label: "t3.mjpeg.sub.\(target.description)",
      maxPendingWrites: 2,
      send: { data in conn.writeAll(data) },
      onClose: {
        if let id = subRef?.id {
          session.removeMjpegSubscriber(id)
        }
        conn.close()
      }
    )
    subRef = sub

    Task {
      do {
        try await session.addMjpegSubscriber(sub)
        DispatchQueue.global().async {
          var byte: UInt8 = 0
          while true {
            let n = Darwin.recv(conn.fd, &byte, 1, 0)
            if n <= 0 {
              if n < 0 && errno == EINTR { continue }
              break
            }
          }
          sub.markClosed()
          session.removeMjpegSubscriber(sub.id)
          conn.close()
        }
      } catch {
        sub.markClosed()
        conn.close()
      }
    }
  }

  private static func sampleSystemCursor() -> (hash: Int, message: CursorShapeMessage)? {
    let snapshot: (NSImage, NSPoint)? = DispatchQueue.main.sync {
      guard let cur = NSCursor.currentSystem else { return nil }
      return (cur.image, cur.hotSpot)
    }
    guard let (img, hotSpot) = snapshot else { return nil }
    let logicalW = min(48, max(1, Int(img.size.width.rounded())))
    let logicalH = min(48, max(1, Int(img.size.height.rounded())))
    var rect = CGRect(x: 0, y: 0, width: logicalW, height: logicalH)
    guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
      return nil
    }
    let pngData: Data?
    if cg.width == logicalW && cg.height == logicalH {
      let rep = NSBitmapImageRep(cgImage: cg)
      pngData = rep.representation(using: .png, properties: [:])
    } else if let ctx = CGContext(
      data: nil,
      width: logicalW,
      height: logicalH,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) {
      ctx.interpolationQuality = .high
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: logicalW, height: logicalH))
      if let scaled = ctx.makeImage() {
        pngData = NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:])
      } else {
        pngData = nil
      }
    } else {
      pngData = nil
    }
    guard let pngData, !pngData.isEmpty else { return nil }
    let hsX = min(logicalW - 1, max(0, Int(hotSpot.x.rounded())))
    let hsY = min(logicalH - 1, max(0, Int(hotSpot.y.rounded())))
    var hasher = Hasher()
    hasher.combine(pngData)
    hasher.combine(hsX)
    hasher.combine(hsY)
    let msg = CursorShapeMessage(
      type: "cursor",
      dataUrl: "data:image/png;base64,\(pngData.base64EncodedString())",
      hotspotX: hsX,
      hotspotY: hsY,
      width: logicalW,
      height: logicalH
    )
    return (hasher.finalize(), msg)
  }

  private func serveInputWebSocket(conn: SocketConnection, req: HttpRequest, target: CaptureTargetKey) {
    guard let key = req.headers["sec-websocket-key"] else {
      conn.sendHttpResponse(status: "400 Bad Request", contentType: "text/plain", body: Data("Missing key".utf8))
      return
    }
    let magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    let digest = Insecure.SHA1.hash(data: Data(magic.utf8))
    let accept = Data(digest).base64EncodedString()

    let upgrade =
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: \(accept)\r\n\r\n"
    guard conn.writeAll(Data(upgrade.utf8)) else {
      conn.close()
      return
    }

    let session = CaptureManager.shared.session(for: target)
    let subId = UUID()
    session.addMetaSubscriber(id: subId) { meta in
      if let data = try? JSONEncoder().encode(meta) {
        _ = conn.sendWsFrame(opcode: 0x1, payload: data)
      }
    }

    // Send initial bounds immediately even before first frame if window exists.
    if case .window(let wid) = target, let info = WindowDiscovery.shared.liveWindowInfo(windowId: wid) {
      let initial = ScreenMetaMessage(
        type: "screen",
        width: Int(info.bounds.width.rounded()),
        height: Int(info.bounds.height.rounded()),
        scale: 2.0,
        title: info.title,
        appName: nil
      )
      if let data = try? JSONEncoder().encode(initial) {
        _ = conn.sendWsFrame(opcode: 0x1, payload: data)
      }
    }

    var lastCursorHash: Int = 0
    var lastCursorCheckTime: CFAbsoluteTime = 0
    let pushCursorIfChanged: (Bool) -> Void = { force in
      let now = CFAbsoluteTimeGetCurrent()
      if !force && (now - lastCursorCheckTime) < 0.06 { return }
      lastCursorCheckTime = now
      guard let sampled = Self.sampleSystemCursor() else { return }
      if !force && sampled.hash == lastCursorHash { return }
      lastCursorHash = sampled.hash
      if let data = try? JSONEncoder().encode(sampled.message) {
        _ = conn.sendWsFrame(opcode: 0x1, payload: data)
      }
    }
    pushCursorIfChanged(true)

    let decoder = JSONDecoder()
    while let msg = conn.readWsMessage() {
      switch msg.opcode {
      case 0x1:  // Text
        if let cmd = try? decoder.decode(InputCommand.self, from: msg.payload) {
          InputInjector.shared.handle(cmd, target: target)
          if cmd.type == "mouse" || cmd.type == "wheel" {
            pushCursorIfChanged(false)
          }
        }
      case 0x8:  // Close
        _ = conn.sendWsFrame(opcode: 0x8, payload: Data())
        session.removeMetaSubscriber(id: subId)
        conn.close()
        return
      case 0x9:  // Ping
        _ = conn.sendWsFrame(opcode: 0xA, payload: msg.payload)
      default:
        break
      }
    }

    session.removeMetaSubscriber(id: subId)
    conn.close()
  }
}
