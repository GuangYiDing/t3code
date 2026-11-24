import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createHostWindowEnvironmentAtoms } from "@t3tools/client-runtime/state/host-window";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const HOST_WINDOW_BASE_PATH = "/api/host-window";

export const hostWindowEnvironment = createHostWindowEnvironmentAtoms(connectionAtomRuntime);

const hostWindowAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: HOST_WINDOW_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`host-window-access:${environmentId}`)),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("host-window-access:empty"),
);

export function useHostWindowAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : hostWindowAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function refreshHostWindowAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(hostWindowAccessAtom(environmentId));
}
