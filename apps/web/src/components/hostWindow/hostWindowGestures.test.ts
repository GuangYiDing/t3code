import { describe, expect, it } from "vite-plus/test";

import {
  applyTrackpadDelta,
  clampViewportPan,
  computePinchTransform,
  MAX_VIEWPORT_ZOOM,
  normalizeWheelDelta,
  normalizedPointFromRect,
} from "./hostWindowGestures";

describe("hostWindowGestures", () => {
  it("normalizes wheel deltas across pixel, line, and page modes", () => {
    expect(normalizeWheelDelta(120, 0)).toBe(120);
    expect(normalizeWheelDelta(3, 1)).toBe(96);
    expect(normalizeWheelDelta(-1, 2)).toBe(-400);
  });

  it("normalizes and clamps pointer coordinates within media bounds", () => {
    const rect = { left: 100, top: 50, width: 800, height: 400 };
    expect(normalizedPointFromRect(rect, 500, 250)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedPointFromRect(rect, 0, 999)).toEqual({ x: 0, y: 1 });
    expect(normalizedPointFromRect({ left: 0, top: 0, width: 0, height: 100 }, 10, 10)).toBeNull();
  });

  it("applies accelerated relative trackpad motion and clamps to [0, 1]", () => {
    const slow = applyTrackpadDelta({ x: 0.5, y: 0.5 }, 10, 0, 1000, 500);
    const fast = applyTrackpadDelta({ x: 0.5, y: 0.5 }, 50, 0, 1000, 500);
    expect(slow.x).toBeGreaterThan(0.51);
    expect(slow.x).toBeLessThan(0.52);
    // Fast flick moves more than 5x the slow 10px delta due to pointer acceleration
    expect(fast.x - 0.5).toBeGreaterThan((slow.x - 0.5) * 5);

    const clamped = applyTrackpadDelta({ x: 0.99, y: 0.01 }, 500, -500, 800, 400);
    expect(clamped).toEqual({ x: 1, y: 0 });
  });

  it("clamps zoom to [1, 4] and resets pan at 1x", () => {
    expect(clampViewportPan(120, -80, 0.7, 1000, 600)).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(clampViewportPan(9999, -9999, 6, 1000, 600)).toEqual({
      zoom: MAX_VIEWPORT_ZOOM,
      panX: 1500,
      panY: -900,
    });
  });

  it("keeps the pinch focal point anchored while zooming in", () => {
    // Stage is 1000x600 centered at (500, 300). Pinching 2x around (700, 400) (+200, +100 from center)
    // should pan by (-200, -100) so the same content stays under (700, 400).
    const next = computePinchTransform({
      startZoom: 1,
      startPanX: 0,
      startPanY: 0,
      startMidX: 700,
      startMidY: 400,
      currMidX: 700,
      currMidY: 400,
      scaleRatio: 2,
      stageCenterX: 500,
      stageCenterY: 300,
      stageWidth: 1000,
      stageHeight: 600,
    });
    expect(next).toEqual({ zoom: 2, panX: -200, panY: -100 });
  });
});
