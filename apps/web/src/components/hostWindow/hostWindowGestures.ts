export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface ViewportTransform {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

const MIN_VIEWPORT_ZOOM = 1;
export const MAX_VIEWPORT_ZOOM = 4;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const normalizeWheelDelta = (delta: number, deltaMode: number): number => {
  if (deltaMode === 1) return delta * 32; // DOM_DELTA_LINE
  if (deltaMode === 2) return delta * 400; // DOM_DELTA_PAGE
  return delta; // DOM_DELTA_PIXEL
};

export const normalizedPointFromRect = (
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
): NormalizedPoint | null => {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
};

/**
 * Applies relative single-finger trackpad motion to a normalized virtual cursor [0..1, 0..1].
 * Uses a mild acceleration curve (1.1x for slow precision moves, up to 2.1x for fast flicks)
 * similar to UU Remote / macOS trackpad pointer mode.
 */
export const applyTrackpadDelta = (
  cursor: NormalizedPoint,
  dxPx: number,
  dyPx: number,
  mediaWidth: number,
  mediaHeight: number,
): NormalizedPoint => {
  if (mediaWidth <= 0 || mediaHeight <= 0) return cursor;
  const speed = Math.hypot(dxPx, dyPx);
  const gain = Math.min(2.1, 1.1 + speed * 0.035);
  return {
    x: clamp01(cursor.x + (dxPx * gain) / mediaWidth),
    y: clamp01(cursor.y + (dyPx * gain) / mediaHeight),
  };
};

/**
 * Clamps pan offsets so the zoomed stage never drifts completely away from the viewport.
 * Transform uses `transform-origin: center center` with `translate3d(panX, panY, 0) scale(zoom)`.
 */
export const clampViewportPan = (
  panX: number,
  panY: number,
  zoom: number,
  stageWidth: number,
  stageHeight: number,
): ViewportTransform => {
  const clampedZoom = Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, zoom));
  if (clampedZoom <= 1.001) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const maxPanX = ((clampedZoom - 1) * stageWidth) / 2;
  const maxPanY = ((clampedZoom - 1) * stageHeight) / 2;
  return {
    zoom: clampedZoom,
    panX: Math.max(-maxPanX, Math.min(maxPanX, panX)),
    panY: Math.max(-maxPanY, Math.min(maxPanY, panY)),
  };
};

/**
 * Computes the next zoom + pan transform during a two-finger pinch gesture so the visual point
 * underneath the initial pinch midpoint stays anchored beneath the current midpoint.
 */
export const computePinchTransform = (params: {
  readonly startZoom: number;
  readonly startPanX: number;
  readonly startPanY: number;
  readonly startMidX: number;
  readonly startMidY: number;
  readonly currMidX: number;
  readonly currMidY: number;
  readonly scaleRatio: number;
  readonly stageCenterX: number;
  readonly stageCenterY: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
}): ViewportTransform => {
  const nextZoom = Math.max(
    MIN_VIEWPORT_ZOOM,
    Math.min(MAX_VIEWPORT_ZOOM, params.startZoom * params.scaleRatio),
  );
  const ratio = nextZoom / params.startZoom;
  // Stage-relative coordinates of the initial and current midpoints around transform-origin center.
  const sx = params.startMidX - params.stageCenterX;
  const sy = params.startMidY - params.stageCenterY;
  const cx = params.currMidX - params.stageCenterX;
  const cy = params.currMidY - params.stageCenterY;
  const nextPanX = cx - (sx - params.startPanX) * ratio;
  const nextPanY = cy - (sy - params.startPanY) * ratio;
  return clampViewportPan(nextPanX, nextPanY, nextZoom, params.stageWidth, params.stageHeight);
};
