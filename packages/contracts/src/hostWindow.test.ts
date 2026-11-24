import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  HostWindowListResult,
  HostWindowPermissions,
  HostWindowRequestPermissionsInput,
} from "./hostWindow.ts";

const decodeListResult = Schema.decodeSync(HostWindowListResult);
const decodePermissions = Schema.decodeSync(HostWindowPermissions);
const decodeRequestPermissionsInput = Schema.decodeSync(HostWindowRequestPermissionsInput);

describe("hostWindow contracts", () => {
  it("decodes a host window list result with windows and displays", () => {
    const parsed = decodeListResult({
      supported: true,
      status: "ready",
      permissions: { screenRecording: true, accessibility: true },
      windows: [
        {
          id: 1024,
          appName: "Google Chrome",
          bundleId: "com.google.Chrome",
          pid: 4242,
          title: "GitHub",
          width: 1440,
          height: 900,
          x: 0,
          y: 25,
          isOnScreen: true,
          iconBase64: "iVBORw0KGgo=",
        },
      ],
      displays: [{ id: 1, width: 1920, height: 1080, scale: 2, isMain: true }],
      streamBasePath: "/api/host-window",
    });

    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]?.appName).toBe("Google Chrome");
    expect(parsed.displays[0]?.isMain).toBe(true);
  });

  it("decodes permissions and permission request input", () => {
    const perms = decodePermissions({
      screenRecording: false,
      accessibility: true,
    });
    expect(perms.screenRecording).toBe(false);
    expect(perms.accessibility).toBe(true);

    const input = decodeRequestPermissionsInput({
      openSettings: true,
    });
    expect(input.openSettings).toBe(true);
  });
});
