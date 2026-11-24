import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HostWindowTargetKind = Schema.Literals(["window", "display"]);
export type HostWindowTargetKind = typeof HostWindowTargetKind.Type;

export const HostWindowPermissions = Schema.Struct({
  screenRecording: Schema.Boolean,
  accessibility: Schema.Boolean,
});
export type HostWindowPermissions = typeof HostWindowPermissions.Type;

export const HostWindowSummary = Schema.Struct({
  id: Schema.Int,
  appName: Schema.String,
  bundleId: Schema.String,
  pid: Schema.Int,
  title: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  x: Schema.Number,
  y: Schema.Number,
  isOnScreen: Schema.Boolean,
  iconBase64: Schema.optional(Schema.NullOr(Schema.String)),
});
export type HostWindowSummary = typeof HostWindowSummary.Type;

export const HostDisplaySummary = Schema.Struct({
  id: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  scale: Schema.Number,
  isMain: Schema.Boolean,
});
export type HostDisplaySummary = typeof HostDisplaySummary.Type;

export const HostWindowStatus = Schema.Literals([
  "unsupported",
  "idle",
  "starting",
  "ready",
  "failed",
]);
export type HostWindowStatus = typeof HostWindowStatus.Type;

export const HostWindowListResult = Schema.Struct({
  supported: Schema.Boolean,
  status: HostWindowStatus,
  detail: Schema.optional(Schema.String),
  permissions: HostWindowPermissions,
  windows: Schema.Array(HostWindowSummary),
  displays: Schema.Array(HostDisplaySummary),
  streamBasePath: TrimmedNonEmptyString,
});
export type HostWindowListResult = typeof HostWindowListResult.Type;

export const HostWindowListInput = Schema.Struct({});
export type HostWindowListInput = typeof HostWindowListInput.Type;

export const HostWindowRequestPermissionsInput = Schema.Struct({
  openSettings: Schema.optional(Schema.Boolean),
});
export type HostWindowRequestPermissionsInput = typeof HostWindowRequestPermissionsInput.Type;

export class HostWindowUnavailableError extends Schema.TaggedError<HostWindowUnavailableError>()(
  "HostWindowUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class HostWindowOperationError extends Schema.TaggedError<HostWindowOperationError>()(
  "HostWindowOperationError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Host window ${this.operation} failed: ${this.reason}`;
  }
}

export const HostWindowError = Schema.Union([HostWindowUnavailableError, HostWindowOperationError]);
export type HostWindowError = typeof HostWindowError.Type;
