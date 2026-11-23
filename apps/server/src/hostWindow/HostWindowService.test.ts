// @effect-diagnostics nodeBuiltinImport:off - Test checks whether the native macOS helper binary is built on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as HostWindowService from "./HostWindowService.ts";

const hostWindowTestLayer = HostWindowService.layer.pipe(Layer.provide(FetchHttpClient.layer));

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// oxlint-disable-next-line t3code/no-global-process-runtime -- Test locates the host-built macOS binary when present.
const arch = process.arch === "x64" ? "x64" : "arm64";
const helperBinary = NodePath.resolve(
  here,
  "../../../../native/macos-window-stream/build",
  arch,
  "t3-macos-window-stream",
);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native helper test runs only on macOS when built.
const canRunNative = process.platform === "darwin" && NodeFS.existsSync(helperBinary);

describe("HostWindowService", () => {
  it.live.skipIf(!canRunNative)(
    "lazily starts the macOS helper, lists windows/displays, and stops cleanly on scope exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HostWindowService.HostWindowService;
          expect(yield* service.currentEndpoint).toBeNull();
          const result = yield* service.list;
          expect(yield* service.currentEndpoint).not.toBeNull();
          expect(result.supported).toBe(true);
          expect(result.status).toBe("ready");
          expect(result.streamBasePath).toBe("/api/host-window");
          expect(result.displays.length).toBeGreaterThan(0);
        }).pipe(Effect.provide(hostWindowTestLayer)),
      ),
  );
});
