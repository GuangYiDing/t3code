import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

final class WindowDiscovery {
  static let shared = WindowDiscovery()

  private let iconLock = NSLock()
  private var iconCache: [String: String] = [:]

  func permissionsStatus() -> PermissionsStatus {
    PermissionsStatus(
      screenRecording: CGPreflightScreenCaptureAccess(),
      accessibility: AXIsProcessTrusted()
    )
  }

  func requestPermissions() -> PermissionsStatus {
    _ = CGRequestScreenCaptureAccess()
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    return permissionsStatus()
  }

  func listTargets() async -> WindowListResponse {
    let perms = permissionsStatus()
    guard perms.screenRecording else {
      return WindowListResponse(permissions: perms, windows: [], displays: listDisplaysFallback())
    }

    do {
      // Only include on-screen windows: hidden off-screen macOS helper windows (e.g. invisible popovers)
      // never emit frames in ScreenCaptureKit.
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      let onScreenOrder = currentOnScreenWindowOrder()
      let selfPid = getpid()
      let excludedBundles: Set<String> = [
        "com.apple.dock",
        "com.apple.WindowManager",
        "com.apple.controlcenter",
        "com.apple.notificationcenterui",
        "com.apple.Spotlight",
        "com.apple.SystemUIServer",
      ]

      var windows: [WindowSummary] = []
      for w in content.windows {
        guard w.windowLayer == 0 else { continue }
        guard w.isOnScreen else { continue }
        guard w.frame.width >= 120, w.frame.height >= 80 else { continue }
        guard let app = w.owningApplication else { continue }
        guard app.processID != selfPid else { continue }
        let appName = app.applicationName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appName.isEmpty else { continue }
        if excludedBundles.contains(app.bundleIdentifier) { continue }

        let title = (w.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let isOnScreen = onScreenOrder[w.windowID] != nil || w.isOnScreen
        let iconBase64 = cachedIconBase64(bundleId: app.bundleIdentifier, pid: app.processID)

        windows.append(
          WindowSummary(
            id: w.windowID,
            appName: appName,
            bundleId: app.bundleIdentifier,
            pid: app.processID,
            title: title.isEmpty ? appName : title,
            width: Int(w.frame.width.rounded()),
            height: Int(w.frame.height.rounded()),
            x: Double(w.frame.origin.x),
            y: Double(w.frame.origin.y),
            isOnScreen: isOnScreen,
            iconBase64: iconBase64
          )
        )
      }

      // Sort front-to-back using on-screen z-order first, then off-screen windows alphabetically.
      windows.sort { a, b in
        let rankA = onScreenOrder[a.id] ?? Int.max
        let rankB = onScreenOrder[b.id] ?? Int.max
        if rankA != rankB { return rankA < rankB }
        if a.appName != b.appName { return a.appName.localizedCaseInsensitiveCompare(b.appName) == .orderedAscending }
        return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
      }

      let mainDisplayId = CGMainDisplayID()
      let displays = content.displays.map { d -> DisplaySummary in
        let scale = displayScaleFactor(d.displayID)
        return DisplaySummary(
          id: d.displayID,
          width: d.width,
          height: d.height,
          scale: scale,
          isMain: d.displayID == mainDisplayId
        )
      }

      return WindowListResponse(permissions: perms, windows: windows, displays: displays)
    } catch {
      return WindowListResponse(permissions: perms, windows: [], displays: listDisplaysFallback())
    }
  }

  func findSCWindow(id: UInt32) async throws -> SCWindow? {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: false
    )
    return content.windows.first(where: { $0.windowID == id })
  }

  func findSCDisplay(id: UInt32) async throws -> SCDisplay? {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: false
    )
    return content.displays.first(where: { $0.displayID == id })
  }

  func liveWindowInfo(windowId: UInt32) -> (bounds: CGRect, pid: Int32, title: String)? {
    guard
      let infoList = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId)
        as? [[String: Any]],
      let info = infoList.first,
      let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsDict),
      let pid = info[kCGWindowOwnerPID as String] as? Int32
    else {
      return nil
    }
    let title = (info[kCGWindowName as String] as? String) ?? ""
    return (bounds, pid, title)
  }

  func liveDisplayBounds(displayId: UInt32) -> CGRect {
    CGDisplayBounds(displayId)
  }

  func displayScaleFactor(_ displayId: CGDirectDisplayID) -> Double {
    if let mode = CGDisplayCopyDisplayMode(displayId) {
      let pixelWidth = Double(mode.pixelWidth)
      let pointWidth = Double(mode.width)
      if pointWidth > 0 {
        return max(1.0, min(2.0, (pixelWidth / pointWidth).rounded()))
      }
    }
    return 2.0
  }

  private func currentOnScreenWindowOrder() -> [UInt32: Int] {
    var order: [UInt32: Int] = [:]
    guard
      let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
      ) as? [[String: Any]]
    else {
      return order
    }
    for (index, item) in list.enumerated() {
      if let num = item[kCGWindowNumber as String] as? UInt32 {
        order[num] = index
      } else if let num = item[kCGWindowNumber as String] as? Int {
        order[UInt32(num)] = index
      }
    }
    return order
  }

  private func listDisplaysFallback() -> [DisplaySummary] {
    var count: UInt32 = 0
    var active = [CGDirectDisplayID](repeating: 0, count: 16)
    guard CGGetActiveDisplayList(16, &active, &count) == .success else { return [] }
    let mainId = CGMainDisplayID()
    return active.prefix(Int(count)).map { id in
      let b = CGDisplayBounds(id)
      return DisplaySummary(
        id: id,
        width: Int(b.width),
        height: Int(b.height),
        scale: displayScaleFactor(id),
        isMain: id == mainId
      )
    }
  }

  private func cachedIconBase64(bundleId: String, pid: Int32) -> String? {
    let key = bundleId.isEmpty ? "pid:\(pid)" : bundleId
    iconLock.lock()
    if let cached = iconCache[key] {
      iconLock.unlock()
      return cached
    }
    iconLock.unlock()

    guard let app = NSRunningApplication(processIdentifier: pid),
      let icon = app.icon,
      let cgImage = icon.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
      return nil
    }
    let width = 32
    let height = 32
    guard
      let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      return nil
    }
    ctx.interpolationQuality = .high
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let resized = ctx.makeImage() else { return nil }
    let rep = NSBitmapImageRep(cgImage: resized)
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    let b64 = png.base64EncodedString()
    iconLock.lock()
    iconCache[key] = b64
    iconLock.unlock()
    return b64
  }
}
