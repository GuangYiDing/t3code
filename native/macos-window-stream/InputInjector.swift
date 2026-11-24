import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

final class InputInjector {
  static let shared = InputInjector()
  private let queue = DispatchQueue(label: "t3.window.input", qos: .userInteractive)
  private var lastFocusPid: Int32 = -1
  private var lastFocusWindowId: UInt32 = 0
  private var lastFocusTime: CFAbsoluteTime = 0
  private var cachedBoundsTarget: CaptureTargetKey?
  private var cachedBoundsValue: (CGRect, Int32?, String?)?
  private var cachedBoundsTime: CFAbsoluteTime = 0
  private var heldButtons: Set<String> = []
  private let clipboardLock = NSLock()
  private var lastInjectedPasteboardCount: Int = -1

  func currentInjectedPasteboardCount() -> Int {
    clipboardLock.lock()
    defer { clipboardLock.unlock() }
    return lastInjectedPasteboardCount
  }

  func pasteFile(at fileURL: URL, target: CaptureTargetKey) {
    queue.async { [weak self] in
      guard let self, AXIsProcessTrusted() else { return }
      let changeCount: Int = DispatchQueue.main.sync {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects([fileURL as NSURL])
        return pb.changeCount
      }
      self.clipboardLock.lock()
      self.lastInjectedPasteboardCount = changeCount
      self.clipboardLock.unlock()

      self.focusTarget(target, force: true)
      usleep(60_000)
      self.postKey(keyCode: CGKeyCode(kVK_ANSI_V), isDown: true, flags: .maskCommand)
      self.postKey(keyCode: CGKeyCode(kVK_ANSI_V), isDown: false, flags: .maskCommand)
    }
  }

  func handle(_ command: InputCommand, target: CaptureTargetKey) {
    queue.async { [weak self] in
      self?.execute(command, target: target)
    }
  }

  private func execute(_ command: InputCommand, target: CaptureTargetKey) {
    guard AXIsProcessTrusted() else { return }

    switch command.type {
    case "focus":
      focusTarget(target, force: true)
    case "resize":
      handleResize(command, target: target)
    case "mouse":
      handleMouse(command, target: target)
    case "wheel":
      handleWheel(command, target: target)
    case "key":
      handleKey(command, target: target)
    case "text":
      if let text = command.text, !text.isEmpty {
        focusTarget(target, force: false)
        injectUnicodeText(text)
      }
    case "clipboard":
      if let text = command.text {
        let changeCount: Int = DispatchQueue.main.sync {
          let pb = NSPasteboard.general
          pb.clearContents()
          pb.setString(text, forType: .string)
          return pb.changeCount
        }
        clipboardLock.lock()
        lastInjectedPasteboardCount = changeCount
        clipboardLock.unlock()
        if command.paste == true {
          focusTarget(target, force: true)
          postKey(keyCode: CGKeyCode(kVK_ANSI_V), isDown: true, flags: .maskCommand)
          postKey(keyCode: CGKeyCode(kVK_ANSI_V), isDown: false, flags: .maskCommand)
        }
      }
    default:
      break
    }
  }

  private func handleResize(_ command: InputCommand, target: CaptureTargetKey) {
    guard case .window = target,
      let reqW = command.width,
      let reqH = command.height,
      reqW >= 320,
      reqH >= 240
    else {
      return
    }
    guard let (bounds, pidOpt, titleOpt) = resolveBoundsAndPid(target, forceRefresh: true),
      let pid = pidOpt,
      let axWin = findBestAXWindow(pid: pid, expectedBounds: bounds, expectedTitle: titleOpt ?? "")
    else {
      return
    }

    let displays = activeDisplayBounds()
    let menuBarInset: CGFloat = 30
    let targetDisplay =
      displays.max { a, b in
        let interA = a.intersection(bounds)
        let interB = b.intersection(bounds)
        let areaA = interA.isNull ? 0 : interA.width * interA.height
        let areaB = interB.isNull ? 0 : interB.width * interB.height
        return areaA < areaB
      } ?? displays.first ?? CGRect(x: 0, y: 0, width: 1920, height: 1080)

    let availW = max(320, targetDisplay.width)
    let availH = max(240, targetDisplay.height - menuBarInset)
    let ratio = Double(reqW) / Double(reqH)
    var fittedW = min(Double(reqW), Double(availW))
    var fittedH = fittedW / ratio
    if fittedH > Double(availH) {
      fittedH = Double(availH)
      fittedW = fittedH * ratio
    }
    var newSize = CGSize(width: fittedW.rounded(), height: fittedH.rounded())
    var newOrigin = CGPoint(
      x: targetDisplay.minX + max(0, (targetDisplay.width - newSize.width) / 2).rounded(),
      y: targetDisplay.minY + menuBarInset + max(0, (availH - newSize.height) / 2).rounded()
    )

    if let posVal = AXValueCreate(.cgPoint, &newOrigin) {
      AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, posVal)
    }
    if let sizeVal = AXValueCreate(.cgSize, &newSize) {
      AXUIElementSetAttributeValue(axWin, kAXSizeAttribute as CFString, sizeVal)
    }
    AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(axWin, kAXMainAttribute as CFString, kCFBooleanTrue)

    cachedBoundsTarget = nil
    cachedBoundsValue = nil
  }

  private func resolveBoundsAndPid(_ target: CaptureTargetKey, forceRefresh: Bool = false) -> (
    CGRect, Int32?, String?
  )? {
    let now = CFAbsoluteTimeGetCurrent()
    if !forceRefresh,
      cachedBoundsTarget == target,
      let cached = cachedBoundsValue,
      (now - cachedBoundsTime) < 0.25
    {
      return cached
    }
    let fresh: (CGRect, Int32?, String?)?
    switch target {
    case .window(let windowId):
      if let info = WindowDiscovery.shared.liveWindowInfo(windowId: windowId) {
        fresh = (info.bounds, info.pid, info.title)
      } else {
        fresh = nil
      }
    case .display(let displayId):
      fresh = (WindowDiscovery.shared.liveDisplayBounds(displayId: displayId), nil, nil)
    }
    cachedBoundsTarget = target
    cachedBoundsValue = fresh
    cachedBoundsTime = now
    return fresh
  }

  private func screenPoint(nx: Double, ny: Double, bounds: CGRect) -> CGPoint {
    let clampedX = max(0.0, min(1.0, nx))
    let clampedY = max(0.0, min(1.0, ny))
    return CGPoint(
      x: bounds.origin.x + clampedX * bounds.size.width,
      y: bounds.origin.y + clampedY * bounds.size.height
    )
  }

  private func activeDisplayBounds() -> [CGRect] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
  }

  private func isPointOnAnyDisplay(_ pt: CGPoint, displays: [CGRect]) -> Bool {
    return displays.contains { rect in
      pt.x >= rect.minX && pt.x < rect.maxX && pt.y >= rect.minY && pt.y < rect.maxY
    }
  }

  /// If a remote-controlled window was dragged mostly off-screen so the interaction point falls
  /// outside every active display, macOS drops or clamps synthetic CGEvents. Nudge the window
  /// back into the nearest display so clicks and scrolls land on real screen pixels.
  private func ensureTargetPointOnScreen(
    _ target: CaptureTargetKey,
    nx: Double,
    ny: Double,
    bounds: CGRect,
    pid: Int32?,
    title: String?
  ) -> CGPoint {
    let pt = screenPoint(nx: nx, ny: ny, bounds: bounds)
    guard case .window = target, let pid else { return pt }
    let displays = activeDisplayBounds()
    guard !displays.isEmpty, !isPointOnAnyDisplay(pt, displays: displays) else {
      return pt
    }

    // Pick the display with the largest intersection, or nearest center if completely off-screen.
    let winCenter = CGPoint(x: bounds.midX, y: bounds.midY)
    let targetDisplay =
      displays.max { a, b in
        let interA = a.intersection(bounds)
        let interB = b.intersection(bounds)
        let areaA = interA.isNull ? 0 : interA.width * interA.height
        let areaB = interB.isNull ? 0 : interB.width * interB.height
        if areaA != areaB { return areaA < areaB }
        let distA = hypot(a.midX - winCenter.x, a.midY - winCenter.y)
        let distB = hypot(b.midX - winCenter.x, b.midY - winCenter.y)
        return distA > distB
      } ?? displays[0]

    let menuBarInset: CGFloat = 30
    let maxX = max(targetDisplay.minX, targetDisplay.maxX - bounds.width)
    let maxY = max(targetDisplay.minY + menuBarInset, targetDisplay.maxY - bounds.height)
    let clampedX = min(max(bounds.origin.x, targetDisplay.minX), maxX)
    let clampedY = min(max(bounds.origin.y, targetDisplay.minY + menuBarInset), maxY)
    let newOrigin = CGPoint(x: clampedX, y: clampedY)

    if let axWin = findBestAXWindow(pid: pid, expectedBounds: bounds, expectedTitle: title ?? "") {
      var pos = newOrigin
      if let posVal = AXValueCreate(.cgPoint, &pos) {
        AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, posVal)
      }
      AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
      AXUIElementSetAttributeValue(axWin, kAXMainAttribute as CFString, kCFBooleanTrue)
    }

    cachedBoundsTarget = nil
    cachedBoundsValue = nil
    if let (refreshedBounds, _, _) = resolveBoundsAndPid(target, forceRefresh: true) {
      return screenPoint(nx: nx, ny: ny, bounds: refreshedBounds)
    }
    return screenPoint(nx: nx, ny: ny, bounds: CGRect(origin: newOrigin, size: bounds.size))
  }

  private func findBestAXWindow(
    pid: Int32,
    expectedBounds: CGRect,
    expectedTitle: String
  ) -> AXUIElement? {
    let appElem = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &value) == .success,
      let windows = value as? [AXUIElement],
      !windows.isEmpty
    else {
      return nil
    }

    var bestMatch: AXUIElement?
    var bestScore = Double.infinity

    for w in windows {
      var posVal: CFTypeRef?
      var sizeVal: CFTypeRef?
      var pos = CGPoint.zero
      var size = CGSize.zero
      if AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &posVal) == .success,
        let posVal, CFGetTypeID(posVal) == AXValueGetTypeID()
      {
        AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
      }
      if AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sizeVal) == .success,
        let sizeVal, CFGetTypeID(sizeVal) == AXValueGetTypeID()
      {
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
      }

      var titleVal: CFTypeRef?
      let title =
        (AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleVal) == .success
          ? (titleVal as? String)
          : nil) ?? ""

      let dist =
        abs(pos.x - expectedBounds.origin.x)
        + abs(pos.y - expectedBounds.origin.y)
        + abs(size.width - expectedBounds.size.width)
        + abs(size.height - expectedBounds.size.height)
      let titlePenalty = (!expectedTitle.isEmpty && title == expectedTitle) ? 0.0 : 40.0
      let score = dist + titlePenalty
      if score < bestScore {
        bestScore = score
        bestMatch = w
      }
    }

    return bestMatch
  }

  private func focusTarget(_ target: CaptureTargetKey, force: Bool) {
    guard case .window(let windowId) = target else { return }
    guard let (bounds, pidOpt, titleOpt) = resolveBoundsAndPid(target, forceRefresh: force),
      let pid = pidOpt
    else {
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    if !force {
      if lastFocusPid == pid && lastFocusWindowId == windowId && (now - lastFocusTime) < 1.5 {
        return
      }
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        && lastFocusWindowId == windowId
      {
        lastFocusTime = now
        return
      }
    }
    lastFocusPid = pid
    lastFocusWindowId = windowId
    lastFocusTime = now

    if let app = NSRunningApplication(processIdentifier: pid) {
      app.activate()
    }
    raiseWindowViaAX(pid: pid, expectedBounds: bounds, expectedTitle: titleOpt ?? "")
  }

  private func raiseWindowViaAX(pid: Int32, expectedBounds: CGRect, expectedTitle: String) {
    if let targetWin = findBestAXWindow(
      pid: pid,
      expectedBounds: expectedBounds,
      expectedTitle: expectedTitle
    ) {
      AXUIElementPerformAction(targetWin, kAXRaiseAction as CFString)
      AXUIElementSetAttributeValue(targetWin, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
  }

  private func roundedNonZero(_ value: Double) -> Int32 {
    if abs(value) < 0.05 { return 0 }
    let rounded = Int32(value.rounded())
    if rounded != 0 { return rounded }
    return value > 0 ? 1 : -1
  }

  private func handleMouse(_ command: InputCommand, target: CaptureTargetKey) {
    guard let nx = command.x, let ny = command.y, let action = command.action else { return }
    guard let (bounds, pid, title) = resolveBoundsAndPid(target, forceRefresh: action == "down")
    else {
      return
    }
    let pt: CGPoint
    if action == "down" {
      pt = ensureTargetPointOnScreen(
        target,
        nx: nx,
        ny: ny,
        bounds: bounds,
        pid: pid,
        title: title
      )
    } else {
      pt = screenPoint(nx: nx, ny: ny, bounds: bounds)
    }
    let buttonName = command.button ?? "left"
    let flags = cgEventFlags(from: command.modifiers ?? 0)

    let eventType: CGEventType
    let cgButton: CGMouseButton

    switch action {
    case "down":
      focusTarget(target, force: false)
      heldButtons.insert(buttonName)
      switch buttonName {
      case "right":
        eventType = .rightMouseDown
        cgButton = .right
      case "middle":
        eventType = .otherMouseDown
        cgButton = .center
      default:
        eventType = .leftMouseDown
        cgButton = .left
      }
    case "up":
      heldButtons.remove(buttonName)
      switch buttonName {
      case "right":
        eventType = .rightMouseUp
        cgButton = .right
      case "middle":
        eventType = .otherMouseUp
        cgButton = .center
      default:
        eventType = .leftMouseUp
        cgButton = .left
      }
    case "move":
      if heldButtons.contains("left") || buttonName == "left" {
        eventType = .leftMouseDragged
        cgButton = .left
      } else if heldButtons.contains("right") || buttonName == "right" {
        eventType = .rightMouseDragged
        cgButton = .right
      } else if heldButtons.contains("middle") || buttonName == "middle" {
        eventType = .otherMouseDragged
        cgButton = .center
      } else {
        eventType = .mouseMoved
        cgButton = .left
      }
    default:
      return
    }

    guard
      let ev = CGEvent(
        mouseEventSource: nil,
        mouseType: eventType,
        mouseCursorPosition: pt,
        mouseButton: cgButton
      )
    else {
      return
    }
    ev.flags = flags
    if let clickCount = command.clickCount, clickCount >= 1 {
      ev.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
    }
    ev.post(tap: .cghidEventTap)
  }

  private func handleWheel(_ command: InputCommand, target: CaptureTargetKey) {
    guard let nx = command.x, let ny = command.y else { return }
    guard let (bounds, pid, title) = resolveBoundsAndPid(target) else { return }
    focusTarget(target, force: false)
    let pt = ensureTargetPointOnScreen(
      target,
      nx: nx,
      ny: ny,
      bounds: bounds,
      pid: pid,
      title: title
    )
    let flags = cgEventFlags(from: command.modifiers ?? 0)

    // Move cursor over the scroll point and stamp wheel.location so WindowServer hit-tests
    // the exact target view instead of the default (0, screenHeight) origin.
    if let move = CGEvent(
      mouseEventSource: nil,
      mouseType: .mouseMoved,
      mouseCursorPosition: pt,
      mouseButton: .left
    ) {
      move.post(tap: .cghidEventTap)
    }

    let dy = roundedNonZero(-(command.deltaY ?? 0))
    let dx = roundedNonZero(-(command.deltaX ?? 0))
    if dy == 0 && dx == 0 { return }
    guard
      let wheel = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: dy,
        wheel2: dx,
        wheel3: 0
      )
    else {
      return
    }
    wheel.location = pt
    wheel.flags = flags
    wheel.post(tap: .cghidEventTap)
  }

  private func handleKey(_ command: InputCommand, target: CaptureTargetKey) {
    guard let action = command.action else { return }
    let isDown = (action == "down")
    if isDown {
      focusTarget(target, force: false)
    }
    let flags = cgEventFlags(from: command.modifiers ?? 0)
    if let code = command.code, let vk = Self.domCodeToVirtualKey[code] {
      postKey(keyCode: vk, isDown: isDown, flags: flags)
      return
    }
    if isDown, let key = command.key, key.count == 1, flags.isDisjoint(with: [.maskCommand, .maskControl]) {
      injectUnicodeText(key)
    }
  }

  private func postKey(keyCode: CGKeyCode, isDown: Bool, flags: CGEventFlags) {
    guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: isDown) else {
      return
    }
    ev.flags = flags
    ev.post(tap: .cghidEventTap)
  }

  private func injectUnicodeText(_ text: String) {
    let utf16 = Array(text.utf16)
    var index = 0
    while index < utf16.count {
      let end = min(index + 16, utf16.count)
      var slice = Array(utf16[index..<end])
      if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      {
        down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
        up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: &slice)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
      }
      index = end
    }
  }

  /// Bitmask matching T3 Code's `previewStreamModifiers`: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.
  private func cgEventFlags(from mask: Int) -> CGEventFlags {
    var flags: CGEventFlags = []
    if (mask & 1) != 0 { flags.insert(.maskAlternate) }
    if (mask & 2) != 0 { flags.insert(.maskControl) }
    if (mask & 4) != 0 { flags.insert(.maskCommand) }
    if (mask & 8) != 0 { flags.insert(.maskShift) }
    return flags
  }

  private static let domCodeToVirtualKey: [String: CGKeyCode] = [
    "KeyA": CGKeyCode(kVK_ANSI_A), "KeyS": CGKeyCode(kVK_ANSI_S), "KeyD": CGKeyCode(kVK_ANSI_D),
    "KeyF": CGKeyCode(kVK_ANSI_F), "KeyH": CGKeyCode(kVK_ANSI_H), "KeyG": CGKeyCode(kVK_ANSI_G),
    "KeyZ": CGKeyCode(kVK_ANSI_Z), "KeyX": CGKeyCode(kVK_ANSI_X), "KeyC": CGKeyCode(kVK_ANSI_C),
    "KeyV": CGKeyCode(kVK_ANSI_V), "KeyB": CGKeyCode(kVK_ANSI_B), "KeyQ": CGKeyCode(kVK_ANSI_Q),
    "KeyW": CGKeyCode(kVK_ANSI_W), "KeyE": CGKeyCode(kVK_ANSI_E), "KeyR": CGKeyCode(kVK_ANSI_R),
    "KeyY": CGKeyCode(kVK_ANSI_Y), "KeyT": CGKeyCode(kVK_ANSI_T), "KeyO": CGKeyCode(kVK_ANSI_O),
    "KeyU": CGKeyCode(kVK_ANSI_U), "KeyI": CGKeyCode(kVK_ANSI_I), "KeyP": CGKeyCode(kVK_ANSI_P),
    "KeyL": CGKeyCode(kVK_ANSI_L), "KeyJ": CGKeyCode(kVK_ANSI_J), "KeyK": CGKeyCode(kVK_ANSI_K),
    "KeyN": CGKeyCode(kVK_ANSI_N), "KeyM": CGKeyCode(kVK_ANSI_M),
    "Digit1": CGKeyCode(kVK_ANSI_1), "Digit2": CGKeyCode(kVK_ANSI_2), "Digit3": CGKeyCode(kVK_ANSI_3),
    "Digit4": CGKeyCode(kVK_ANSI_4), "Digit5": CGKeyCode(kVK_ANSI_5), "Digit6": CGKeyCode(kVK_ANSI_6),
    "Digit7": CGKeyCode(kVK_ANSI_7), "Digit8": CGKeyCode(kVK_ANSI_8), "Digit9": CGKeyCode(kVK_ANSI_9),
    "Digit0": CGKeyCode(kVK_ANSI_0),
    "Equal": CGKeyCode(kVK_ANSI_Equal), "Minus": CGKeyCode(kVK_ANSI_Minus),
    "BracketRight": CGKeyCode(kVK_ANSI_RightBracket), "BracketLeft": CGKeyCode(kVK_ANSI_LeftBracket),
    "Quote": CGKeyCode(kVK_ANSI_Quote), "Semicolon": CGKeyCode(kVK_ANSI_Semicolon),
    "Backslash": CGKeyCode(kVK_ANSI_Backslash), "Comma": CGKeyCode(kVK_ANSI_Comma),
    "Slash": CGKeyCode(kVK_ANSI_Slash), "Period": CGKeyCode(kVK_ANSI_Period),
    "Backquote": CGKeyCode(kVK_ANSI_Grave),
    "Enter": CGKeyCode(kVK_Return), "NumpadEnter": CGKeyCode(kVK_ANSI_KeypadEnter),
    "Tab": CGKeyCode(kVK_Tab), "Space": CGKeyCode(kVK_Space),
    "Backspace": CGKeyCode(kVK_Delete), "Delete": CGKeyCode(kVK_ForwardDelete),
    "Escape": CGKeyCode(kVK_Escape),
    "ArrowLeft": CGKeyCode(kVK_LeftArrow), "ArrowRight": CGKeyCode(kVK_RightArrow),
    "ArrowDown": CGKeyCode(kVK_DownArrow), "ArrowUp": CGKeyCode(kVK_UpArrow),
    "Home": CGKeyCode(kVK_Home), "End": CGKeyCode(kVK_End),
    "PageUp": CGKeyCode(kVK_PageUp), "PageDown": CGKeyCode(kVK_PageDown),
    "F1": CGKeyCode(kVK_F1), "F2": CGKeyCode(kVK_F2), "F3": CGKeyCode(kVK_F3),
    "F4": CGKeyCode(kVK_F4), "F5": CGKeyCode(kVK_F5), "F6": CGKeyCode(kVK_F6),
    "F7": CGKeyCode(kVK_F7), "F8": CGKeyCode(kVK_F8), "F9": CGKeyCode(kVK_F9),
    "F10": CGKeyCode(kVK_F10), "F11": CGKeyCode(kVK_F11), "F12": CGKeyCode(kVK_F12),
    "MetaLeft": CGKeyCode(kVK_Command), "MetaRight": CGKeyCode(kVK_RightCommand),
    "ShiftLeft": CGKeyCode(kVK_Shift), "ShiftRight": CGKeyCode(kVK_RightShift),
    "AltLeft": CGKeyCode(kVK_Option), "AltRight": CGKeyCode(kVK_RightOption),
    "ControlLeft": CGKeyCode(kVK_Control), "ControlRight": CGKeyCode(kVK_RightControl),
  ]
}
