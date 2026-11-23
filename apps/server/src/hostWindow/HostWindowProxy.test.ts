import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  HostWindowUnavailableError,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as HostWindowProxy from "./HostWindowProxy.ts";
import * as HostWindowService from "./HostWindowService.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope>, available = true) => {
  const requests: string[] = [];
  const headers: Array<Readonly<Record<string, string>>> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      headers.push(request.headers);
      return HttpClientResponse.fromWeb(
        request,
        new Response("avcc-bytes", {
          headers: {
            "content-type": "application/octet-stream",
            "set-cookie": "should-be-stripped=1",
          },
        }),
      );
    }),
  );

  const { handler, dispose } = HttpRouter.toWebHandler(
    HostWindowProxy.layer.pipe(
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(HostWindowService.HostWindowService)({
          ensureEndpoint: available
            ? Effect.succeed({ origin: "http://127.0.0.1:45555", token: "helper-secret" })
            : Effect.fail(new HostWindowUnavailableError({ reason: "unavailable" })),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(
        Layer.mock(SessionStore.SessionStore, {
          cookieName: "test",
          legacyCookieName: undefined,
          awaitInvalidation: () => Effect.never,
        }),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, headers };
};

describe("host window proxy", () => {
  it("proxies allowed AVCC stream requests with helper bearer auth and strips cookies", async () => {
    const { handler, requests, headers } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      new Request("https://env.test/api/host-window/window/42/stream.avcc?wsTicket=secret-ticket"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("avcc-bytes");
    expect(requests).toEqual(["http://127.0.0.1:45555/window/42/stream.avcc"]);
    expect(headers[0]?.authorization).toBe("Bearer helper-secret");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  });

  it("rejects unknown paths and non-GET HTTP methods", async () => {
    const { handler, requests } = fixture([AuthOrchestrationReadScope]);

    const disallowed = await handler(
      new Request("https://env.test/api/host-window/permissions/request"),
    );
    expect(disallowed.status).toBe(404);

    const badMethod = await handler(
      new Request("https://env.test/api/host-window/windows", { method: "POST" }),
    );
    expect(badMethod.status).toBe(405);
    expect(requests).toEqual([]);
  });

  it("returns 503 when the host window helper is unavailable", async () => {
    const { handler } = fixture([AuthOrchestrationReadScope], false);
    const response = await handler(new Request("https://env.test/api/host-window/windows"));
    expect(response.status).toBe(503);
  });
});
