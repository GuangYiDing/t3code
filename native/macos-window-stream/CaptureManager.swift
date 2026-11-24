import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

final class StreamSubscriber: @unchecked Sendable {
  let id = UUID()
  private let queue: DispatchQueue
  private let sendFn: (Data) -> Bool
  private let closeFn: () -> Void
  private let lock = NSLock()
  private var closed = false
  private var pendingWrites = 0
  private let maxPendingWrites: Int

  init(
    label: String,
    maxPendingWrites: Int = 8,
    send: @escaping (Data) -> Bool,
    onClose: @escaping () -> Void
  ) {
    self.queue = DispatchQueue(label: label, qos: .userInteractive)
    self.maxPendingWrites = maxPendingWrites
    self.sendFn = send
    self.closeFn = onClose
  }

  func enqueue(_ data: Data, droppable: Bool) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    if droppable && pendingWrites >= maxPendingWrites {
      lock.unlock()
      return
    }
    pendingWrites += 1
    lock.unlock()

    queue.async { [weak self] in
      guard let self else { return }
      let ok = self.sendFn(data)
      self.lock.lock()
      self.pendingWrites = max(0, self.pendingWrites - 1)
      let shouldClose = !ok && !self.closed
      if shouldClose { self.closed = true }
      self.lock.unlock()
      if shouldClose {
        self.closeFn()
      }
    }
  }

  func markClosed() {
    lock.lock()
    closed = true
    lock.unlock()
  }
}

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let target: CaptureTargetKey
  private let captureQueue = DispatchQueue(label: "t3.window.capture", qos: .userInteractive)
  private let lock = NSLock()

  private var stream: SCStream?
  private var encoder: H264Encoder?
  private var avccSubscribers: [UUID: StreamSubscriber] = [:]
  private var mjpegSubscribers: [UUID: StreamSubscriber] = [:]
  private var metaSubscribers: [UUID: (ScreenMetaMessage) -> Void] = [:]

  private var latestDescription: Data?
  private var latestSeedJpeg: Data?
  private var latestMeta: ScreenMetaMessage?
  private var lastMjpegTime: CFTimeInterval = 0
  private var currentPixelWidth: Int32 = 0
  private var currentPixelHeight: Int32 = 0
  private var currentPointWidth: Int = 0
  private var currentPointHeight: Int = 0
  private var currentScale: Double = 2.0
  private var targetTitle: String?
  private var targetAppName: String?
  private var isStarting = false
  private var isRunning = false
  private var idleWorkItem: DispatchWorkItem?
  private let onIdleStop: (CaptureTargetKey) -> Void

  init(target: CaptureTargetKey, onIdleStop: @escaping (CaptureTargetKey) -> Void) {
    self.target = target
    self.onIdleStop = onIdleStop
    super.init()
  }

  func addAvccSubscriber(_ sub: StreamSubscriber) async throws {
    let (seed, desc, needStart): (Data?, Data?, Bool) = lock.withLock {
      idleWorkItem?.cancel()
      idleWorkItem = nil
      avccSubscribers[sub.id] = sub
      let shouldStart = !isRunning && !isStarting
      if shouldStart { isStarting = true }
      return (latestSeedJpeg, latestDescription, shouldStart)
    }

    if let seed {
      sub.enqueue(AvccWire.pack(tag: .seed, payload: seed), droppable: false)
    }
    if let desc {
      sub.enqueue(AvccWire.pack(tag: .description, payload: desc), droppable: false)
    }

    if needStart {
      do {
        try await startCapture()
      } catch {
        lock.withLock {
          isStarting = false
          avccSubscribers.removeValue(forKey: sub.id)
        }
        throw error
      }
    } else {
      lock.withLock {
        encoder?.requestKeyframe()
      }
    }
  }

  func removeAvccSubscriber(_ id: UUID) {
    let empty: Bool = lock.withLock {
      avccSubscribers.removeValue(forKey: id)
      return avccSubscribers.isEmpty && mjpegSubscribers.isEmpty
    }
    if empty { scheduleIdleStop() }
  }

  func addMjpegSubscriber(_ sub: StreamSubscriber) async throws {
    let (seed, needStart): (Data?, Bool) = lock.withLock {
      idleWorkItem?.cancel()
      idleWorkItem = nil
      mjpegSubscribers[sub.id] = sub
      let shouldStart = !isRunning && !isStarting
      if shouldStart { isStarting = true }
      return (latestSeedJpeg, shouldStart)
    }

    if let seed {
      sub.enqueue(Self.mjpegPart(seed), droppable: false)
    }

    if needStart {
      do {
        try await startCapture()
      } catch {
        lock.withLock {
          isStarting = false
          mjpegSubscribers.removeValue(forKey: sub.id)
        }
        throw error
      }
    }
  }

  func removeMjpegSubscriber(_ id: UUID) {
    let empty: Bool = lock.withLock {
      mjpegSubscribers.removeValue(forKey: id)
      return avccSubscribers.isEmpty && mjpegSubscribers.isEmpty
    }
    if empty { scheduleIdleStop() }
  }

  func addMetaSubscriber(id: UUID, handler: @escaping (ScreenMetaMessage) -> Void) {
    lock.lock()
    metaSubscribers[id] = handler
    let meta = latestMeta
    lock.unlock()
    if let meta {
      handler(meta)
    }
  }

  func removeMetaSubscriber(id: UUID) {
    lock.lock()
    metaSubscribers.removeValue(forKey: id)
    lock.unlock()
  }

  func currentMeta() -> ScreenMetaMessage? {
    lock.lock()
    defer { lock.unlock() }
    return latestMeta
  }

  private func scheduleIdleStop() {
    lock.lock()
    idleWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let stillEmpty = self.avccSubscribers.isEmpty && self.mjpegSubscribers.isEmpty
      self.lock.unlock()
      if stillEmpty {
        Task {
          await self.stopCapture()
          self.onIdleStop(self.target)
        }
      }
    }
    idleWorkItem = item
    lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + 2.0, execute: item)
  }

  private func startCapture() async throws {
    let filter: SCContentFilter
    let pointW: Int
    let pointH: Int
    let scale: Double
    var title: String?
    var appName: String?

    switch target {
    case .window(let windowId):
      guard let window = try await WindowDiscovery.shared.findSCWindow(id: windowId) else {
        throw NSError(
          domain: "T3WindowStream",
          code: 404,
          userInfo: [NSLocalizedDescriptionKey: "Window \(windowId) not found"]
        )
      }
      filter = SCContentFilter(desktopIndependentWindow: window)
      pointW = max(1, Int(window.frame.width.rounded()))
      pointH = max(1, Int(window.frame.height.rounded()))
      scale = Self.displayScaleForRect(window.frame)
      title = window.title
      appName = window.owningApplication?.applicationName
    case .display(let displayId):
      guard let display = try await WindowDiscovery.shared.findSCDisplay(id: displayId) else {
        throw NSError(
          domain: "T3WindowStream",
          code: 404,
          userInfo: [NSLocalizedDescriptionKey: "Display \(displayId) not found"]
        )
      }
      filter = SCContentFilter(display: display, excludingWindows: [])
      pointW = max(1, display.width)
      pointH = max(1, display.height)
      scale = WindowDiscovery.shared.displayScaleFactor(displayId)
      title = "Display \(displayId)"
      appName = "macOS Display"
    }

    let (encW, encH) = Self.targetPixelDimensions(pointW: pointW, pointH: pointH, scale: scale)
    let config = Self.makeStreamConfig(width: encW, height: encH)

    let scStream = SCStream(filter: filter, configuration: config, delegate: self)
    try scStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)

    let meta = ScreenMetaMessage(
      type: "screen",
      width: pointW,
      height: pointH,
      scale: scale,
      title: title,
      appName: appName
    )

    let metas: [(ScreenMetaMessage) -> Void] = lock.withLock {
      self.stream = scStream
      self.currentPointWidth = pointW
      self.currentPointHeight = pointH
      self.currentScale = scale
      self.targetTitle = title
      self.targetAppName = appName
      self.latestMeta = meta
      self.recreateEncoderLocked(width: Int32(encW), height: Int32(encH))
      self.isStarting = false
      self.isRunning = true
      return Array(self.metaSubscribers.values)
    }

    for cb in metas { cb(meta) }

    try await scStream.startCapture()
  }

  func stopCapture() async {
    let scStream: SCStream? = lock.withLock {
      let existing = stream
      stream = nil
      encoder?.invalidate()
      encoder = nil
      isRunning = false
      isStarting = false
      return existing
    }

    if let scStream {
      try? await scStream.stopCapture()
    }
  }

  private func recreateEncoderLocked(width: Int32, height: Int32) {
    encoder?.invalidate()
    currentPixelWidth = width & ~1
    currentPixelHeight = height & ~1
    latestDescription = nil

    encoder = H264Encoder(
      width: currentPixelWidth,
      height: currentPixelHeight,
      fps: 60,
      onDescription: { [weak self] avcC in
        guard let self else { return }
        let packet = AvccWire.pack(tag: .description, payload: avcC)
        self.lock.lock()
        self.latestDescription = avcC
        let subs = Array(self.avccSubscribers.values)
        self.lock.unlock()
        for s in subs { s.enqueue(packet, droppable: false) }
      },
      onFrame: { [weak self] isKey, payload in
        guard let self else { return }
        let packet = AvccWire.pack(tag: isKey ? .keyframe : .delta, payload: payload)
        self.lock.lock()
        let subs = Array(self.avccSubscribers.values)
        self.lock.unlock()
        for s in subs { s.enqueue(packet, droppable: !isKey) }
      }
    )
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard type == .screen else { return }
    guard CMSampleBufferIsValid(sampleBuffer) else { return }

    // Ignore idle / blank status frames from ScreenCaptureKit.
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(
      sampleBuffer,
      createIfNecessary: false
    ) as? [[SCStreamFrameInfo: Any]],
      let first = attachments.first,
      let statusRaw = first[.status] as? Int,
      let status = SCFrameStatus(rawValue: statusRaw)
    {
      if status != SCFrameStatus.complete { return }

      // Track live window resize from ScreenCaptureKit contentRect.
      if let contentRectDict = first[.contentRect] as? NSDictionary,
        let contentRect = CGRect(dictionaryRepresentation: contentRectDict),
        contentRect.width >= 16, contentRect.height >= 16
      {
        let scaleFactor = (first[.scaleFactor] as? Double) ?? currentScale
        let newPointW = Int(contentRect.width.rounded())
        let newPointH = Int(contentRect.height.rounded())
        if abs(newPointW - currentPointWidth) >= 2 || abs(newPointH - currentPointHeight) >= 2 {
          handleResize(pointW: newPointW, pointH: newPointH, scale: scaleFactor)
        }
      }
    }

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let bufW = Int32(CVPixelBufferGetWidth(pixelBuffer))
    let bufH = Int32(CVPixelBufferGetHeight(pixelBuffer))
    guard bufW >= 2, bufH >= 2 else { return }

    lock.lock()
    let hasAvcc = !avccSubscribers.isEmpty
    let hasMjpeg = !mjpegSubscribers.isEmpty
    let needSeed = (latestSeedJpeg == nil)
    if hasAvcc && (encoder == nil || currentPixelWidth != (bufW & ~1) || currentPixelHeight != (bufH & ~1)) {
      recreateEncoderLocked(width: bufW, height: bufH)
    }
    let enc = encoder
    let mjpegSubs = hasMjpeg ? Array(mjpegSubscribers.values) : []
    lock.unlock()

    if needSeed || hasMjpeg {
      let now = CFAbsoluteTimeGetCurrent()
      if needSeed || (now - lastMjpegTime >= 1.0 / 24.0) {
        lastMjpegTime = now
        if let jpeg = H264Encoder.encodeJpeg(pixelBuffer: pixelBuffer, quality: 0.70) {
          let seedSubs: [StreamSubscriber] = lock.withLock {
            let wasNil = (latestSeedJpeg == nil)
            latestSeedJpeg = jpeg
            return wasNil ? Array(avccSubscribers.values) : []
          }
          if !seedSubs.isEmpty {
            let seedPacket = AvccWire.pack(tag: .seed, payload: jpeg)
            for sub in seedSubs { sub.enqueue(seedPacket, droppable: true) }
          }
          if !mjpegSubs.isEmpty {
            let part = Self.mjpegPart(jpeg)
            for sub in mjpegSubs { sub.enqueue(part, droppable: true) }
          }
        }
      }
    }

    if hasAvcc, let enc {
      let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      let dur = CMSampleBufferGetDuration(sampleBuffer)
      enc.encode(pixelBuffer: pixelBuffer, pts: pts, duration: dur)
    }
  }

  private func handleResize(pointW: Int, pointH: Int, scale: Double) {
    let (encW, encH) = Self.targetPixelDimensions(pointW: pointW, pointH: pointH, scale: scale)
    let meta = ScreenMetaMessage(
      type: "screen",
      width: pointW,
      height: pointH,
      scale: scale,
      title: targetTitle,
      appName: targetAppName
    )

    lock.lock()
    currentPointWidth = pointW
    currentPointHeight = pointH
    currentScale = scale
    latestMeta = meta
    let scStream = stream
    let metas = Array(metaSubscribers.values)
    lock.unlock()

    for cb in metas { cb(meta) }

    if let scStream {
      let cfg = Self.makeStreamConfig(width: encW, height: encH)
      Task {
        try? await scStream.updateConfiguration(cfg)
      }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let reasonPayload = (try? JSONEncoder().encode(["reason": error.localizedDescription])) ?? Data()
    let endPacket = AvccWire.pack(tag: .end, payload: reasonPayload)
    lock.lock()
    isRunning = false
    let subs = Array(avccSubscribers.values)
    lock.unlock()
    for s in subs { s.enqueue(endPacket, droppable: false) }
  }

  private static func displayScaleForRect(_ rect: CGRect) -> Double {
    var displayCount: UInt32 = 0
    var displays = [CGDirectDisplayID](repeating: 0, count: 4)
    if CGGetDisplaysWithRect(rect, 4, &displays, &displayCount) == .success, displayCount > 0 {
      return WindowDiscovery.shared.displayScaleFactor(displays[0])
    }
    return WindowDiscovery.shared.displayScaleFactor(CGMainDisplayID())
  }

  private static func targetPixelDimensions(pointW: Int, pointH: Int, scale: Double) -> (Int, Int) {
    let rawW = Double(pointW) * scale
    let rawH = Double(pointH) * scale
    let maxSide = 2240.0
    let factor = min(1.0, maxSide / max(rawW, rawH))
    let w = max(2, Int((rawW * factor).rounded()) & ~1)
    let h = max(2, Int((rawH * factor).rounded()) & ~1)
    return (w, h)
  }

  private static func makeStreamConfig(width: Int, height: Int) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.scalesToFit = true
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    // Hide the host OS cursor in the video stream so clients render a single zero-latency
    // local cursor (native hardware cursor or virtual trackpad pointer) with synced shape.
    config.showsCursor = false
    config.queueDepth = 2
    return config
  }

  private static func mjpegPart(_ jpeg: Data) -> Data {
    var data = Data()
    let header =
      "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n"
    data.append(contentsOf: header.utf8)
    data.append(jpeg)
    data.append(contentsOf: "\r\n".utf8)
    return data
  }
}

final class CaptureManager {
  static let shared = CaptureManager()
  private let lock = NSLock()
  private var sessions: [CaptureTargetKey: CaptureSession] = [:]

  func session(for target: CaptureTargetKey) -> CaptureSession {
    lock.lock()
    defer { lock.unlock() }
    if let existing = sessions[target] { return existing }
    let created = CaptureSession(target: target) { [weak self] key in
      self?.lock.lock()
      self?.sessions.removeValue(forKey: key)
      self?.lock.unlock()
    }
    sessions[target] = created
    return created
  }

  func snapshotJpeg(for target: CaptureTargetKey) async throws -> Data {
    let filter: SCContentFilter
    let width: Int
    let height: Int

    switch target {
    case .window(let windowId):
      guard let window = try await WindowDiscovery.shared.findSCWindow(id: windowId) else {
        throw NSError(domain: "T3WindowStream", code: 404)
      }
      filter = SCContentFilter(desktopIndependentWindow: window)
      width = min(1280, max(2, Int(window.frame.width)))
      height = min(900, max(2, Int(window.frame.height)))
    case .display(let displayId):
      guard let display = try await WindowDiscovery.shared.findSCDisplay(id: displayId) else {
        throw NSError(domain: "T3WindowStream", code: 404)
      }
      filter = SCContentFilter(display: display, excludingWindows: [])
      width = min(1280, max(2, display.width))
      height = min(900, max(2, display.height))
    }

    let cfg = SCStreamConfiguration()
    cfg.width = width
    cfg.height = height
    cfg.showsCursor = false

    let cgImage = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: cfg
    )
    let ciImage = CIImage(cgImage: cgImage)
    let ctx = CIContext(options: nil)
    guard
      let data = ctx.jpegRepresentation(
        of: ciImage,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.75]
      )
    else {
      throw NSError(domain: "T3WindowStream", code: 500)
    }
    return data
  }
}
