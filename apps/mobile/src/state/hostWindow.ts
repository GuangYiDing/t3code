import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { createHostWindowEnvironmentAtoms } from "@t3tools/client-runtime/state/host-window";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

const HOST_WINDOW_BASE_PATH = "/api/host-window";

export const hostWindowEnvironment = createHostWindowEnvironmentAtoms(connectionAtomRuntime);

const hostWindowAccessNotBeforeAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.withLabel(`mobile-host-window-retry:${environmentId}`)),
);

const hostWindowAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      const notBefore = get(hostWindowAccessNotBeforeAtom(environmentId));
      if (prepared === null) return Effect.never;
      const resolve = resolveDeviceHubAccess({ prepared, hubBasePath: HOST_WINDOW_BASE_PATH });
      const wait = notBefore - Date.now();
      return wait > 0 ? Effect.andThen(Effect.sleep(wait), resolve) : resolve;
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-host-window-access:${environmentId}`)),
);

export function useHostWindowAccess(environmentId: EnvironmentId) {
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(hostWindowAccessAtom(environmentId));
  const access = query.data && query.error === null && Option.isSome(prepared) ? query.data : null;
  return {
    access,
    error: query.error,
    refresh: query.refresh,
    retryAfter: (delayMs: number) => {
      appAtomRegistry.set(hostWindowAccessNotBeforeAtom(environmentId), Date.now() + delayMs);
    },
  };
}
