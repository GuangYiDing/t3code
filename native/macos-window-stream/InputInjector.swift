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
  private var heldButtons: Set<String> = []

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
        DispatchQueue.main.sync {
          let pb = NSPasteboard.general
          pb.clearContents()
          pb.setString(text, forType: .string)
        }
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

  private func resolveBoundsAndPid(_ target: CaptureTargetKey) -> (CGRect, Int32?, String?)? {
    switch target {
    case .window(let windowId):
      guard let info = WindowDiscovery.shared.liveWindowInfo(windowId: windowId) else { return nil }
      return (info.bounds, info.pid, info.title)
    case .display(let displayId):
      return (WindowDiscovery.shared.liveDisplayBounds(displayId: displayId), nil, nil)
    }
  }

  private func screenPoint(nx: Double, ny: Double, bounds: CGRect) -> CGPoint {
    let clampedX = max(0.0, min(1.0, nx))
    let clampedY = max(0.0, min(1.0, ny))
    return CGPoint(
      x: bounds.origin.x + clampedX * bounds.size.width,
      y: bounds.origin.y + clampedY * bounds.size.height
    )
  }

  private func focusTarget(_ target: CaptureTargetKey, force: Bool) {
    guard case .window(let windowId) = target else { return }
    guard let info = WindowDiscovery.shared.liveWindowInfo(windowId: windowId) else { return }
    let now = CFAbsoluteTimeGetCurrent()
    if !force && lastFocusPid == info.pid && lastFocusWindowId == windowId && (now - lastFocusTime) < 0.8 {
      return
    }
    lastFocusPid = info.pid
    lastFocusWindowId = windowId
    lastFocusTime = now

    if let app = NSRunningApplication(processIdentifier: info.pid) {
      app.activate()
    }
    raiseWindowViaAX(pid: info.pid, expectedBounds: info.bounds, expectedTitle: info.title)
  }

  private func raiseWindowViaAX(pid: Int32, expectedBounds: CGRect, expectedTitle: String) {
    let appElem = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &value) == .success,
      let windows = value as? [AXUIElement],
      !windows.isEmpty
    else {
      return
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

    if let targetWin = bestMatch {
      AXUIElementPerformAction(targetWin, kAXRaiseAction as CFString)
      AXUIElementSetAttributeValue(targetWin, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
  }

  private func handleMouse(_ command: InputCommand, target: CaptureTargetKey) {
    guard let nx = command.x, let ny = command.y, let action = command.action else { return }
    guard let (bounds, _, _) = resolveBoundsAndPid(target) else { return }
    let pt = screenPoint(nx: nx, ny: ny, bounds: bounds)
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
    guard let (bounds, _, _) = resolveBoundsAndPid(target) else { return }
    let pt = screenPoint(nx: nx, ny: ny, bounds: bounds)
    let flags = cgEventFlags(from: command.modifiers ?? 0)

    // Move cursor over the scroll point so the right scrollable view receives the wheel event.
    if let move = CGEvent(
      mouseEventSource: nil,
      mouseType: .mouseMoved,
      mouseCursorPosition: pt,
      mouseButton: .left
    ) {
      move.post(tap: .cghidEventTap)
    }

    let dy = Int32((-(command.deltaY ?? 0)).rounded())
    let dx = Int32((-(command.deltaX ?? 0)).rounded())
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
