import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createHostWindowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hostWindow:list",
      tag: WS_METHODS.hostWindowList,
      scheduler,
      concurrency,
    }),
    requestPermissions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hostWindow:requestPermissions",
      tag: WS_METHODS.hostWindowRequestPermissions,
      scheduler,
      concurrency,
    }),
  };
}
