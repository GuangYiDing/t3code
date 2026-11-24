import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The Swift compiler targets the actual host; this build script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- ScreenCaptureKit exists only in the macOS SDK.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: {
    output: { type: "string" },
    arch: { type: "string", default: hostArch },
  },
});

if (hostPlatform !== "darwin") {
  throw new Error("The macOS window stream helper can only be built on macOS.");
}

const targets = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[values.arch];
if (targets === undefined) {
  throw new Error(`Unsupported macOS architecture: ${values.arch}`);
}

const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const sources = [
  "Models.swift",
  "WindowDiscovery.swift",
  "VirtualDisplayManager.swift",
  "H264Encoder.swift",
  "CaptureManager.swift",
  "InputInjector.swift",
  "HttpServer.swift",
  "DemoHtml.swift",
  "Main.swift",
].map((file) => NodePath.resolve(root, file));

const output =
  values.output ?? NodePath.resolve(root, "build", values.arch, "t3-macos-window-stream");

NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
const slices = targets.map((target) => `${temporary}.${target}`);

try {
  targets.forEach((target, index) => {
    NodeChildProcess.execFileSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-swift-version",
        "5",
        "-parse-as-library",
        "-target",
        `${target}-apple-macos14.0`,
        "-framework",
        "AppKit",
        "-framework",
        "ApplicationServices",
        "-framework",
        "Carbon",
        "-framework",
        "CoreGraphics",
        "-framework",
        "CoreImage",
        "-framework",
        "CoreMedia",
        "-framework",
        "CoreVideo",
        "-framework",
        "ScreenCaptureKit",
        "-framework",
        "VideoToolbox",
        ...sources,
        "-o",
        slices[index],
      ],
      { stdio: "inherit" },
    );
  });

  if (slices.length === 1) {
    NodeFS.renameSync(slices[0], temporary);
  } else {
    NodeChildProcess.execFileSync("xcrun", ["lipo", "-create", ...slices, "-output", temporary], {
      stdio: "inherit",
    });
  }
  NodeFS.renameSync(temporary, output);
  console.log(`Built macOS window stream helper: ${output}`);
} finally {
  for (const file of [temporary, ...slices]) {
    NodeFS.rmSync(file, { force: true });
  }
}
