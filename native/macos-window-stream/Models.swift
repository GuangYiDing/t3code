import Foundation

enum AvccTag: UInt8 {
  case description = 1
  case keyframe = 2
  case delta = 3
  case seed = 4
  case end = 7
}

enum AvccWire {
  /// Wire format identical to T3 Code's `packages/client-runtime/src/device/stream.ts` `AvccDemuxer`:
  /// [uint32 big-endian length = 1 + payload.count][uint8 tag][payload]
  static func pack(tag: AvccTag, payload: Data) -> Data {
    var out = Data(capacity: 5 + payload.count)
    var frameLength = UInt32(1 + payload.count).bigEndian
    withUnsafeBytes(of: &frameLength) { out.append(contentsOf: $0) }
    out.append(tag.rawValue)
    out.append(payload)
    return out
  }
}

struct HealthResponse: Codable {
  let ok: Bool
  let pid: Int32
}

struct PermissionsStatus: Codable {
  let screenRecording: Bool
  let accessibility: Bool
}

struct WindowSummary: Codable {
  let id: UInt32
  let appName: String
  let bundleId: String
  let pid: Int32
  let title: String
  let width: Int
  let height: Int
  let x: Double
  let y: Double
  let isOnScreen: Bool
  let iconBase64: String?
}

struct DisplaySummary: Codable {
  let id: UInt32
  let width: Int
  let height: Int
  let scale: Double
  let isMain: Bool
}

struct WindowListResponse: Codable {
  let permissions: PermissionsStatus
  let windows: [WindowSummary]
  let displays: [DisplaySummary]
}

enum CaptureTargetKey: Hashable {
  case window(UInt32)
  case display(UInt32)

  var description: String {
    switch self {
    case .window(let id): return "window:\(id)"
    case .display(let id): return "display:\(id)"
    }
  }
}

struct ScreenMetaMessage: Codable {
  let type: String
  let width: Int
  let height: Int
  let scale: Double
  let title: String?
  let appName: String?
}

struct InputCommand: Decodable {
  let type: String
  let action: String?
  let x: Double?
  let y: Double?
  let button: String?
  let clickCount: Int?
  let deltaX: Double?
  let deltaY: Double?
  let key: String?
  let code: String?
  let modifiers: Int?
  let text: String?
  let paste: Bool?
}
