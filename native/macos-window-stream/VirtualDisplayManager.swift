import CoreGraphics
import Foundation

/// Manages on-demand macOS virtual displays via CoreGraphics' runtime `CGVirtualDisplay` classes.
/// Enables headless Mac mini remote desktops and tablet aspect-ratio matched displays with zero
/// black bars. Displays stay alive only while retained by this helper process and are cleanly
/// torn down on exit.
final class VirtualDisplayManager {
  static let shared = VirtualDisplayManager()

  private struct ManagedDisplay {
    let id: UInt32
    let name: String
    let width: Int
    let height: Int
    let scale: Double
    let displayObject: AnyObject
  }

  private let lock = NSLock()
  private var displays: [UInt32: ManagedDisplay] = [:]
  private var nextSerial: UInt32 = 1

  var isSupported: Bool {
    NSClassFromString("CGVirtualDisplay") != nil
      && NSClassFromString("CGVirtualDisplayDescriptor") != nil
      && NSClassFromString("CGVirtualDisplaySettings") != nil
      && NSClassFromString("CGVirtualDisplayMode") != nil
  }

  func list() -> [VirtualDisplaySummary] {
    lock.lock()
    defer { lock.unlock() }
    return displays.values
      .sorted { $0.id < $1.id }
      .map {
        VirtualDisplaySummary(
          id: $0.id,
          name: $0.name,
          width: $0.width,
          height: $0.height,
          scale: $0.scale
        )
      }
  }

  func create(width: Int, height: Int, hiDPI: Bool, name: String) -> VirtualDisplaySummary? {
    guard
      let descCls = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
      let dispCls = NSClassFromString("CGVirtualDisplay") as? NSObject.Type,
      let settingsCls = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type,
      let modeCls = NSClassFromString("CGVirtualDisplayMode") as? NSObject.Type
    else {
      return nil
    }

    let safeW = max(640, min(3840, width & ~1))
    let safeH = max(480, min(2400, height & ~1))
    let scale: Double = hiDPI ? 2.0 : 1.0
    let maxPixelsW = UInt32(min(5120, safeW * (hiDPI ? 2 : 1)))
    let maxPixelsH = UInt32(min(3200, safeH * (hiDPI ? 2 : 1)))

    let serial: UInt32 = lock.withLock {
      let s = nextSerial
      nextSerial += 1
      return s
    }

    let result: ManagedDisplay? = DispatchQueue.main.sync {
      let desc = descCls.init()
      desc.setValue(name, forKey: "name")
      desc.setValue(maxPixelsW, forKey: "maxPixelsWide")
      desc.setValue(maxPixelsH, forKey: "maxPixelsHigh")
      // Approximate physical tablet size (~230mm wide) so macOS picks natural scaling.
      let mmW = 240.0
      let mmH = mmW * Double(safeH) / Double(safeW)
      desc.setValue(CGSize(width: mmW, height: mmH), forKey: "sizeInMillimeters")
      desc.setValue(UInt32(0x5433), forKey: "productID")
      desc.setValue(UInt32(0x1337), forKey: "vendorID")
      desc.setValue(serial, forKey: "serialNum")
      desc.setValue(DispatchQueue.main, forKey: "queue")

      let allocSel = NSSelectorFromString("alloc")
      let initSel = NSSelectorFromString("initWithDescriptor:")
      guard let initMethod = class_getInstanceMethod(dispCls, initSel) else { return nil }
      typealias InitWithDesc = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
      let initImp = unsafeBitCast(method_getImplementation(initMethod), to: InitWithDesc.self)
      let allocated = dispCls.perform(allocSel).takeUnretainedValue()
      guard let displayObj = initImp(allocated, initSel, desc) else { return nil }

      let displayID = (displayObj.value(forKey: "displayID") as? UInt32) ?? 0
      guard displayID != 0 else { return nil }

      let modeInitSel = NSSelectorFromString("initWithWidth:height:refreshRate:")
      let applySel = NSSelectorFromString("applySettings:")
      guard
        let modeMethod = class_getInstanceMethod(modeCls, modeInitSel),
        let applyMethod = class_getInstanceMethod(dispCls, applySel)
      else {
        return nil
      }
      typealias ModeInit = @convention(c) (AnyObject, Selector, UInt, UInt, Double) -> AnyObject?
      typealias ApplySettings = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
      let modeImp = unsafeBitCast(method_getImplementation(modeMethod), to: ModeInit.self)
      let applyImp = unsafeBitCast(method_getImplementation(applyMethod), to: ApplySettings.self)

      let modeAlloc = modeCls.perform(allocSel).takeUnretainedValue()
      guard let mode = modeImp(modeAlloc, modeInitSel, UInt(safeW), UInt(safeH), 60.0) else {
        return nil
      }

      let settings = settingsCls.init()
      settings.setValue(hiDPI ? 1 : 0, forKey: "hiDPI")
      settings.setValue([mode], forKey: "modes")
      guard applyImp(displayObj, applySel, settings) else { return nil }

      return ManagedDisplay(
        id: displayID,
        name: name,
        width: safeW,
        height: safeH,
        scale: scale,
        displayObject: displayObj
      )
    }

    guard let managed = result else { return nil }
    lock.withLock {
      displays[managed.id] = managed
    }
    return VirtualDisplaySummary(
      id: managed.id,
      name: managed.name,
      width: managed.width,
      height: managed.height,
      scale: managed.scale
    )
  }

  func destroy(id: UInt32) -> Bool {
    let removed: ManagedDisplay? = lock.withLock {
      displays.removeValue(forKey: id)
    }
    return removed != nil
  }
}
