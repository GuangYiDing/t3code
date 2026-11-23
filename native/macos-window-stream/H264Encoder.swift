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
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue!
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

    // Scale bitrate proportionally to pixel area (3 Mbps .. 12 Mbps).
    let pixels = Double(evenW) * Double(evenH)
    let bitrate = Int32(max(3_000_000, min(12_000_000, pixels * 3.5)))

    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AllowFrameReordering,
      value: kCFBooleanFalse
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ProfileLevel,
      value: kVTProfileLevel_H264_Main_AutoLevel
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
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: NSNumber(value: bitrate)
    )
    // Peak data rate limit (bytes per second, 1s window) for smooth interactive scrolling.
    let peakBytesPerSec = Int(Double(bitrate) * 1.5 / 8.0)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_DataRateLimits,
      value: [peakBytesPerSec, 1] as CFArray
    )

    VTCompressionSessionPrepareToEncodeFrames(session)
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
