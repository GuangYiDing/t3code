import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

final class H264Encoder {
  let width: Int32
  let height: Int32

  private var session: VTCompressionSession?
  private let lock = NSLock()
  private var forceNextKeyframe = true
  private var lastAvcC: Data?

  private let onDescription: (Data) -> Void
  private let onFrame: (Bool, Data) -> Void

  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  private static let srgbColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

  init?(
    width: Int32,
    height: Int32,
    fps: Int32 = 60,
    quality: StreamQualityPreset = .balanced,
    onDescription: @escaping (Data) -> Void,
    onFrame: @escaping (Bool, Data) -> Void
  ) {
    // H.264 requires even dimensions.
    let evenW = max(2, width & ~1)
    let evenH = max(2, height & ~1)
    self.width = evenW
    self.height = evenH
    self.onDescription = onDescription
    self.onFrame = onFrame

    var created: VTCompressionSession?
    let encoderSpec: [CFString: Any] = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue!,
      kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
    ]
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: evenW,
      height: evenH,
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: encoderSpec as CFDictionary,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let session = created else {
      return nil
    }
    self.session = session

    let pixels = Double(evenW) * Double(evenH)
    let bitrate = quality.targetBitrate(pixels: pixels)

    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AllowFrameReordering,
      value: kCFBooleanFalse
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxFrameDelayCount,
      value: NSNumber(value: 1)
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ProfileLevel,
      value: quality.useHighProfile
        ? kVTProfileLevel_H264_High_AutoLevel
        : kVTProfileLevel_H264_Main_AutoLevel
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
      value: NSNumber(value: fps * 2)
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
      value: NSNumber(value: 2.0)
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ExpectedFrameRate,
      value: NSNumber(value: fps)
    )
    applyBitrate(session: session, bitrate: bitrate)

    VTCompressionSessionPrepareToEncodeFrames(session)
  }

  private func applyBitrate(session: VTCompressionSession, bitrate: Int32) {
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: NSNumber(value: bitrate)
    )
    let peakBytesPerSec = Int(Double(bitrate) * 1.5 / 8.0)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_DataRateLimits,
      value: [peakBytesPerSec, 1] as CFArray
    )
  }

  func updateBitrate(quality: StreamQualityPreset) {
    lock.lock()
    let s = session
    lock.unlock()
    guard let s else { return }
    let pixels = Double(width) * Double(height)
    applyBitrate(session: s, bitrate: quality.targetBitrate(pixels: pixels))
  }

  func updateBitrate(bps: Int32) {
    lock.lock()
    let s = session
    lock.unlock()
    guard let s else { return }
    let clamped = max(600_000, min(16_000_000, bps))
    applyBitrate(session: s, bitrate: clamped)
  }

  deinit {
    invalidate()
  }

  func invalidate() {
    lock.lock()
    let s = session
    session = nil
    lock.unlock()
    if let s {
      VTCompressionSessionInvalidate(s)
    }
  }

  func requestKeyframe() {
    lock.lock()
    forceNextKeyframe = true
    lock.unlock()
  }

  func encode(pixelBuffer: CVPixelBuffer, pts: CMTime, duration: CMTime) {
    lock.lock()
    guard let session = self.session else {
      lock.unlock()
      return
    }
    let shouldForceKey = forceNextKeyframe
    forceNextKeyframe = false
    lock.unlock()

    var frameProps: CFDictionary?
    if shouldForceKey {
      frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
    }

    VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: pts,
      duration: duration,
      frameProperties: frameProps,
      infoFlagsOut: nil
    ) { [weak self] status, _, sampleBuffer in
      guard status == noErr, let sampleBuffer, let self else { return }
      self.handleEncodedSample(sampleBuffer)
    }
  }

  private func handleEncodedSample(_ sampleBuffer: CMSampleBuffer) {
    var isKeyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
      as? [[CFString: Any]],
      let first = attachments.first,
      let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool
    {
      isKeyframe = !notSync
    }

    if isKeyframe,
      let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
      let atoms = CMFormatDescriptionGetExtension(
        formatDesc,
        extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
      ) as? NSDictionary,
      let avcC = atoms["avcC"] as? Data
    {
      lock.lock()
      let changed = (lastAvcC != avcC)
      lastAvcC = avcC
      lock.unlock()
      if changed {
        onDescription(avcC)
      }
    }

    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let totalLength = CMBlockBufferGetDataLength(dataBuffer)
    guard totalLength > 0 else { return }

    var data = Data(count: totalLength)
    let copyStatus = data.withUnsafeMutableBytes { rawBuf -> OSStatus in
      guard let base = rawBuf.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(
        dataBuffer,
        atOffset: 0,
        dataLength: totalLength,
        destination: base
      )
    }
    guard copyStatus == kCMBlockBufferNoErr else { return }
    onFrame(isKeyframe, data)
  }

  static func encodeJpeg(pixelBuffer: CVPixelBuffer, quality: CGFloat = 0.72) -> Data? {
    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
    return ciContext.jpegRepresentation(
      of: ciImage,
      colorSpace: srgbColorSpace,
      options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
    )
  }
}
