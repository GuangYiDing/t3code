// Loopback-only macOS window stream helper exposes live window video and OS input injection.
// Proxy with environment read scope for streams/snapshots and operate scope for interactive input.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  HostWindowOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { repeatStillFrame } from "../device/mjpegStillFrame.ts";
import { requestUrl } from "../requestUrl.ts";
import * as HostWindowService from "./HostWindowService.ts";
import { closeHostWindowWebRtcSession, createHostWindowWebRtcAnswer } from "./HostWindowWebRtc.ts";

const ALLOWED_GET_PATHS: ReadonlyArray<RegExp> = [
  /^\/windows$/,
  /^\/displays\/virtual$/,
  /^\/(window|display)\/\d+\/(stream\.avcc|stream\.mjpeg|snapshot\.jpg)$/,
];

const ALLOWED_POST_PATHS: ReadonlyArray<RegExp> = [
  /^\/displays\/virtual$/,
  /^\/(window|display)\/\d+\/upload$/,
  /^\/(window|display)\/\d+\/webrtc\/offer$/,
];

const ALLOWED_DELETE_PATHS: ReadonlyArray<RegExp> = [
  /^\/displays\/virtual\/\d+$/,
  /^\/webrtc\/[a-z0-9-]+$/i,
];

const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [/^\/(window|display)\/\d+\/(input|audio)$/];

const WEBRTC_OFFER_PATH = /^(\/(?:window|display)\/\d+)\/webrtc\/offer$/;
const WEBRTC_SESSION_PATH = /^\/webrtc\/([a-z0-9-]+)$/i;

const isOperatePath = (method: string, helperPath: string, upgrade: boolean): boolean => {
  if (upgrade) {
    return /^\/(window|display)\/\d+\/input$/.test(helperPath);
  }
  if (WEBRTC_OFFER_PATH.test(helperPath) || WEBRTC_SESSION_PATH.test(helperPath)) {
    return false;
  }
  return method === "POST" || method === "DELETE";
};

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const pumpFrames = Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
  const { pull } = yield* source.reader;
  while (true) {
    yield* sink.writeAll(yield* pull);
  }
});

const proxyWebSocket = Effect.fn("HostWindowProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
) {
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    headers: { authorization: `Bearer ${token}` },
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(
    Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
    Effect.ignoreCause,
  );
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("HostWindowProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
  invalidated: Effect.Effect<void>,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  if (
    !HttpMethod.isHttpMethod(method) ||
    (method !== "GET" && method !== "HEAD" && method !== "POST" && method !== "DELETE")
  ) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  let upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
  );
  const forwardedFilename = request.headers["x-filename"];
  if (forwardedFilename) {
    upstreamRequest = HttpClientRequest.setHeader(upstreamRequest, "x-filename", forwardedFilename);
  }
  if (method === "POST") {
    const contentType = request.headers["content-type"] ?? "application/octet-stream";
    const bodyBytes = yield* request.arrayBuffer;
    upstreamRequest = HttpClientRequest.bodyUint8Array(
      upstreamRequest,
      new Uint8Array(bodyBytes),
      contentType,
    );
  }
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      name === "content-encoding" ||
      name === "transfer-encoding" ||
      name === "connection" ||
      name === "set-cookie"
    ) {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  headers["cache-control"] = "no-store, no-transform";
  const body = headers["content-type"]?.startsWith("multipart/x-mixed-replace")
    ? repeatStillFrame(response.stream)
    : response.stream;
  return HttpServerResponse.stream(body.pipe(Stream.interruptWhen(invalidated)), {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const helperPath =
    url.value.pathname.slice(HostWindowService.HOST_WINDOW_ROUTE_PREFIX.length) || "/";
  const upgrade = isWebSocketUpgrade(request);
  const method = request.method;
  const knownPath = upgrade
    ? ALLOWED_WS_PATHS.some((pattern) => pattern.test(helperPath))
    : ALLOWED_GET_PATHS.some((pattern) => pattern.test(helperPath)) ||
      ALLOWED_POST_PATHS.some((pattern) => pattern.test(helperPath)) ||
      ALLOWED_DELETE_PATHS.some((pattern) => pattern.test(helperPath));
  if (!knownPath) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (!upgrade) {
    const methodAllowed =
      ((method === "GET" || method === "HEAD") &&
        ALLOWED_GET_PATHS.some((pattern) => pattern.test(helperPath))) ||
      (method === "POST" && ALLOWED_POST_PATHS.some((pattern) => pattern.test(helperPath))) ||
      (method === "DELETE" && ALLOWED_DELETE_PATHS.some((pattern) => pattern.test(helperPath)));
    if (!methodAllowed) {
      return HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
  }

  const session = yield* authenticateMediaRequest(
    isOperatePath(method, helperPath, upgrade)
      ? AuthOrchestrationOperateScope
      : AuthOrchestrationReadScope,
  );
  const sessions = yield* SessionStore.SessionStore;
  const invalidated = sessions.awaitInvalidation(session.sessionId).pipe(
    Effect.catchTags({
      SessionCredentialVerificationError: (error) =>
        failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
    }),
  );

  const sessionDeleteMatch =
    !upgrade && method === "DELETE" ? WEBRTC_SESSION_PATH.exec(helperPath) : null;
  if (sessionDeleteMatch?.[1]) {
    const ok = closeHostWindowWebRtcSession(sessionDeleteMatch[1]);
    return HttpServerResponse.jsonUnsafe({ ok });
  }

  const service = yield* HostWindowService.HostWindowService;
  const endpoint = yield* service.ensureEndpoint.pipe(Effect.option);
  if (Option.isNone(endpoint)) {
    return HttpServerResponse.text("Host window streamer is unavailable", { status: 503 });
  }

  const webrtcOfferMatch =
    !upgrade && method === "POST" ? WEBRTC_OFFER_PATH.exec(helperPath) : null;
  if (webrtcOfferMatch?.[1]) {
    const targetPath = webrtcOfferMatch[1];
    const bodyJson = yield* request.json.pipe(Effect.option);
    const offerSdp =
      Option.isSome(bodyJson) &&
      typeof bodyJson.value === "object" &&
      bodyJson.value !== null &&
      "sdp" in bodyJson.value &&
      typeof (bodyJson.value as { sdp?: unknown }).sdp === "string"
        ? (bodyJson.value as { sdp: string }).sdp
        : null;
    if (!offerSdp) {
      return HttpServerResponse.text("Missing WebRTC SDP offer", { status: 400 });
    }
    const answerResult = yield* Effect.tryPromise({
      try: () =>
        createHostWindowWebRtcAnswer({
          target: {
            helperOrigin: endpoint.value.origin,
            helperToken: endpoint.value.token,
            targetPath,
          },
          offerSdp,
        }),
      catch: (cause) =>
        new HostWindowOperationError({
          operation: "webrtc.offer",
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.option);
    if (Option.isNone(answerResult)) {
      return HttpServerResponse.text("Failed to negotiate WebRTC session", { status: 502 });
    }
    return HttpServerResponse.jsonUnsafe(answerResult.value);
  }

  const upstreamUrl = `${endpoint.value.origin}${helperPath}`;
  if (upgrade) {
    return yield* Effect.raceFirst(
      proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), endpoint.value.token),
      invalidated.pipe(Effect.as(HttpServerResponse.empty())),
    );
  }
  return yield* proxyHttp(request, upstreamUrl, endpoint.value.token, invalidated);
});

export const layer = HttpRouter.add(
  "*",
  `${HostWindowService.HOST_WINDOW_ROUTE_PREFIX}/*`,
  handler,
);
