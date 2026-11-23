// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Spawns and monitors the standalone native Swift helper process over loopback.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  HostDisplaySummary,
  HostWindowListResult,
  HostWindowOperationError,
  HostWindowPermissions,
  HostWindowSummary,
  HostWindowUnavailableError,
  type HostWindowRequestPermissionsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export const HOST_WINDOW_ROUTE_PREFIX = "/api/host-window";

const HELPER_START_TIMEOUT_MS = 10_000;
const HELPER_REQUEST_TIMEOUT_MS = 8_000;

const HelperWindowsResponse = Schema.Struct({
  permissions: HostWindowPermissions,
  windows: Schema.Array(HostWindowSummary),
  displays: Schema.Array(HostDisplaySummary),
});

export interface HostWindowEndpoint {
  readonly origin: string;
  readonly token: string;
}

interface RunningHelper {
  readonly child: NodeChildProcess.ChildProcess;
  readonly endpoint: HostWindowEndpoint;
}

const decodeHelperWindows = Schema.decodeUnknownSync(HelperWindowsResponse);
const decodePermissions = Schema.decodeUnknownSync(HostWindowPermissions);
const isHostWindowOperationError = Schema.is(HostWindowOperationError);

function resolveHelperBinaryPath(): string | null {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native helper resolution inspects host platform, arch, and override env.
  if (process.platform !== "darwin") return null;

  const explicit = process.env.T3CODE_HOST_WINDOW_HELPER_PATH?.trim();
  if (explicit && NodeFS.existsSync(explicit)) return explicit;

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Match host CPU slice for local dev builds.
  const arch = process.arch === "x64" ? "x64" : "arm64";
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const candidates = [
    // Running from source: apps/server/src/hostWindow/HostWindowService.ts
    NodePath.resolve(
      here,
      "../../../../native/macos-window-stream/build",
      arch,
      "t3-macos-window-stream",
    ),
    NodePath.resolve(
      here,
      "../../../../native/macos-window-stream/build/universal/t3-macos-window-stream",
    ),
    // Running from built server bundle: apps/server/dist/*
    NodePath.resolve(
      here,
      "../../../native/macos-window-stream/build",
      arch,
      "t3-macos-window-stream",
    ),
    NodePath.resolve(
      here,
      "../../../native/macos-window-stream/build/universal/t3-macos-window-stream",
    ),
  ];

  // Electron packaged resources path when bundled inside desktop app.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.unshift(
      NodePath.join(resourcesPath, "macos-window-stream", "t3-macos-window-stream"),
    );
  }

  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnHelperProcess(binaryPath: string): Promise<RunningHelper> {
  return new Promise((resolve, reject) => {
    const token = NodeCrypto.randomBytes(24).toString("hex");
    const child = NodeChildProcess.spawn(binaryPath, ["--port", "0", "--token", token], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Timed out waiting for macOS window stream helper after ${HELPER_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, HELPER_START_TIMEOUT_MS);

    const finish = (err: Error | null, helper?: RunningHelper) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (helper) resolve(helper);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const newline = stdoutBuf.indexOf("\n");
      if (newline === -1) return;
      const line = stdoutBuf.slice(0, newline).trim();
      if (!line.startsWith("READY ")) return;
      try {
        const parsed = JSON.parse(line.slice("READY ".length)) as { port?: number };
        if (typeof parsed.port !== "number" || parsed.port <= 0) {
          finish(new Error("Helper reported an invalid port."));
          return;
        }
        finish(null, {
          child,
          endpoint: { origin: `http://127.0.0.1:${parsed.port}`, token },
        });
      } catch (cause) {
        finish(new Error(`Failed to parse helper READY payload: ${String(cause)}`));
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderrBuf.length < 2000) stderrBuf += chunk;
    });

    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        const detail = stderrBuf.trim() || `exit code ${String(code ?? signal ?? "unknown")}`;
        finish(new Error(`macOS window stream helper exited before ready: ${detail}`));
      }
    });
  });
}

export class HostWindowService extends Context.Service<
  HostWindowService,
  {
    readonly list: Effect.Effect<
      HostWindowListResult,
      HostWindowUnavailableError | HostWindowOperationError
    >;
    readonly requestPermissions: (
      input: HostWindowRequestPermissionsInput,
    ) => Effect.Effect<
      HostWindowPermissions,
      HostWindowUnavailableError | HostWindowOperationError
    >;
    readonly ensureEndpoint: Effect.Effect<
      HostWindowEndpoint,
      HostWindowUnavailableError | HostWindowOperationError
    >;
    readonly currentEndpoint: Effect.Effect<HostWindowEndpoint | null>;
  }
>()("t3/hostWindow/HostWindowService") {}

export const layer = Layer.effect(
  HostWindowService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    let running: RunningHelper | null = null;
    let starting: Promise<RunningHelper> | null = null;

    const stopHelper = Effect.sync(() => {
      const active = running;
      running = null;
      starting = null;
      if (active && active.child.exitCode === null && !active.child.killed) {
        active.child.kill("SIGTERM");
      }
    });

    yield* Effect.addFinalizer(() => stopHelper);

    const ensureRunning = Effect.fn("HostWindowService.ensureRunning")(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Native window streaming is macOS-only in this release.
      if (process.platform !== "darwin") {
        return yield* new HostWindowUnavailableError({
          reason: "Host application streaming is currently supported on macOS environments only.",
        });
      }

      if (running && running.child.exitCode === null && !running.child.killed) {
        return running.endpoint;
      }

      const binaryPath = resolveHelperBinaryPath();
      if (!binaryPath) {
        return yield* new HostWindowUnavailableError({
          reason:
            "macOS window stream helper binary is not built yet. Run `node native/macos-window-stream/build.mjs` on the host.",
        });
      }

      const pending =
        starting ??
        (starting = spawnHelperProcess(binaryPath).then(
          (helper) => {
            running = helper;
            starting = null;
            helper.child.once("exit", () => {
              if (running === helper) running = null;
            });
            return helper;
          },
          (error) => {
            starting = null;
            throw error;
          },
        ));

      const helper = yield* Effect.tryPromise({
        try: () => pending,
        catch: (cause) =>
          new HostWindowOperationError({
            operation: "start",
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      return helper.endpoint;
    });

    const list: Effect.Effect<
      HostWindowListResult,
      HostWindowUnavailableError | HostWindowOperationError
    > = Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Non-macOS servers report unsupported cleanly instead of throwing.
      if (process.platform !== "darwin") {
        return {
          supported: false,
          status: "unsupported" as const,
          detail: "Host application streaming is currently supported on macOS environments only.",
          permissions: { screenRecording: false, accessibility: false },
          windows: [],
          displays: [],
          streamBasePath: HOST_WINDOW_ROUTE_PREFIX,
        };
      }

      const binaryPath = resolveHelperBinaryPath();
      if (!binaryPath) {
        return {
          supported: true,
          status: "failed" as const,
          detail:
            "macOS window stream helper binary is not built yet. Run `node native/macos-window-stream/build.mjs` on this Mac.",
          permissions: { screenRecording: false, accessibility: false },
          windows: [],
          displays: [],
          streamBasePath: HOST_WINDOW_ROUTE_PREFIX,
        };
      }

      const endpoint = yield* ensureRunning();
      const request = HttpClientRequest.get(`${endpoint.origin}/windows`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${endpoint.token}`),
      );
      const payload = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* httpClient.execute(request);
          if (response.status < 200 || response.status >= 300) {
            return yield* new HostWindowOperationError({
              operation: "list",
              reason: `Helper returned HTTP ${response.status}`,
            });
          }
          const json = yield* response.json;
          return yield* Effect.try({
            try: () => decodeHelperWindows(json),
            catch: (cause) =>
              new HostWindowOperationError({
                operation: "list",
                reason: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
        }),
      ).pipe(
        Effect.timeout(HELPER_REQUEST_TIMEOUT_MS),
        Effect.mapError((cause) =>
          isHostWindowOperationError(cause)
            ? cause
            : new HostWindowOperationError({
                operation: "list",
                reason: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
      );

      return {
        supported: true,
        status: "ready" as const,
        permissions: payload.permissions,
        windows: payload.windows,
        displays: payload.displays,
        streamBasePath: HOST_WINDOW_ROUTE_PREFIX,
      };
    });

    const requestPermissions = Effect.fn("HostWindowService.requestPermissions")(function* (
      input: HostWindowRequestPermissionsInput,
    ) {
      const endpoint = yield* ensureRunning();
      const path = input.openSettings ? "/permissions/open-settings" : "/permissions/request";
      const request = HttpClientRequest.post(`${endpoint.origin}${path}`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${endpoint.token}`),
      );
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* httpClient.execute(request);
          if (response.status < 200 || response.status >= 300) {
            return yield* new HostWindowOperationError({
              operation: "requestPermissions",
              reason: `Helper returned HTTP ${response.status}`,
            });
          }
          const json = yield* response.json;
          return yield* Effect.try({
            try: () => decodePermissions(json),
            catch: (cause) =>
              new HostWindowOperationError({
                operation: "requestPermissions",
                reason: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
        }),
      ).pipe(
        Effect.timeout(HELPER_REQUEST_TIMEOUT_MS),
        Effect.mapError((cause) =>
          isHostWindowOperationError(cause)
            ? cause
            : new HostWindowOperationError({
                operation: "requestPermissions",
                reason: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
      );
    });

    const currentEndpoint = Effect.sync(() =>
      running && running.child.exitCode === null && !running.child.killed ? running.endpoint : null,
    );

    return {
      list,
      requestPermissions,
      ensureEndpoint: ensureRunning(),
      currentEndpoint,
    };
  }),
);
