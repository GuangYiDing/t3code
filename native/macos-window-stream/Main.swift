import AppKit
import Foundation

@main
struct MacOSWindowStreamMain {
  static func main() {
    let args = CommandLine.arguments
    var port: UInt16 = 0
    var token: String? = nil
    var demo = false
    var listOnly = false

    var i = 1
    while i < args.count {
      switch args[i] {
      case "--port":
        if i + 1 < args.count, let parsed = UInt16(args[i + 1]) {
          port = parsed
          i += 1
        }
      case "--token":
        if i + 1 < args.count {
          token = args[i + 1]
          i += 1
        }
      case "--demo":
        demo = true
      case "--list":
        listOnly = true
      default:
        break
      }
      i += 1
    }

    // Prevent a Dock icon from appearing while keeping AppKit icon & workspace APIs happy.
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)

    if listOnly {
      Task {
        let result = await WindowDiscovery.shared.listTargets()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(result), let str = String(data: data, encoding: .utf8) {
          print(str)
          fflush(stdout)
        }
        exit(0)
      }
      RunLoop.main.run()
      return
    }

    do {
      let server = try WindowStreamHttpServer(port: port, token: token, demoEnabled: demo)
      server.start()

      let ready: [String: Any] = [
        "port": Int(server.port),
        "url": "http://127.0.0.1:\(server.port)",
        "pid": Int(getpid()),
      ]
      if let data = try? JSONSerialization.data(withJSONObject: ready),
        let json = String(data: data, encoding: .utf8)
      {
        print("READY \(json)")
        fflush(stdout)
      }

      RunLoop.main.run()
    } catch {
      fputs("Failed to start macos-window-stream: \(error.localizedDescription)\n", stderr)
      exit(1)
    }
  }
}
