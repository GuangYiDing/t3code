import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import {
  createHostWindowStreamClient,
  hostWindowModifiers,
  type HostWindowCursorShape,
  type HostWindowInputCommand,
  type HostWindowMouseButton,
  type HostWindowScreenMeta,
  type HostWindowStreamClient,
  type HostWindowStreamStats,
  type HostWindowStreamStatus,
} from "@t3tools/client-runtime/host-window/stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  ClipboardPaste,
  CornerDownLeft,
  Focus,
  Hand,
  HelpCircle,
  Keyboard,
  Layers,
  Monitor,
  MousePointer2,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { HostWindowTabTarget } from "~/rightPanelStore";
import { refreshHostWindowAccess } from "~/state/hostWindow";
import {
  applyTrackpadDelta,
  clampViewportPan,
  computePinchTransform,
  normalizeWheelDelta,
  normalizedPointFromRect,
  type NormalizedPoint,
  type ViewportTransform,
} from "./hostWindowGestures";

const mouseButtonName = (button: number): HostWindowMouseButton =>
  button === 2 ? "right" : button === 1 ? "middle" : "left";

const isTouchFirstDevice = (): boolean => {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(pointer: coarse)").matches) return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

const SINGLE_TAP_MAX_DIST_PX = 10;
const SINGLE_TAP_MAX_MS = 360;
const DOUBLE_TAP_WINDOW_MS = 340;
const LONG_PRESS_MS = 420;
const TWO_FINGER_TAP_MAX_MS = 280;
const TWO_FINGER_TAP_MAX_DIST_PX = 14;
const TWO_FINGER_PINCH_THRESHOLD_PX = 18;
const TWO_FINGER_SCROLL_THRESHOLD_PX = 12;
const THREE_FINGER_SWIPE_THRESHOLD_PX = 42;
const TOUCH_SCROLL_MULTIPLIER = 1.5;

type TouchControlMode = "trackpad" | "direct";

interface TrackedTouch {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

type GesturePhase =
  | "idle"
  | "single-pending"
  | "trackpad-move"
  | "direct-scroll"
  | "direct-pan"
  | "long-press-ready"
  | "left-dragging"
  | "two-finger-pending"
  | "two-finger-scroll"
  | "two-finger-pinch"
  | "three-finger-pending"
  | "three-finger-done";

interface TouchSessionState {
  phase: GesturePhase;
  maxFingers: number;
  startTime: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  twoStartMidX: number;
  twoStartMidY: number;
  twoLastMidX: number;
  twoLastMidY: number;
  twoStartDist: number;
  twoStartViewport: ViewportTransform;
  threeStartY: number;
  panStartX: number;
  panStartY: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

interface TouchFeedbackRipple {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly kind: "left" | "right" | "drag";
}

const DEFAULT_VIEWPORT: ViewportTransform = { zoom: 1, panX: 0, panY: 0 };

const MODIFIER_KEYS = [
  { label: "⌘", bit: 4 },
  { label: "⌃", bit: 2 },
  { label: "⌥", bit: 1 },
  { label: "⇧", bit: 8 },
] as const;

const QUICK_NAV_KEYS = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "←", code: "ArrowLeft" },
  { label: "↑", code: "ArrowUp" },
  { label: "↓", code: "ArrowDown" },
  { label: "→", code: "ArrowRight" },
  { label: "⌫", code: "Backspace" },
  { label: "↵", code: "Enter" },
] as const;

export function HostWindowStreamView(props: {
  readonly environmentId: EnvironmentId;
  readonly target: HostWindowTabTarget;
  readonly access: DeviceHubAccess;
  readonly visible: boolean;
  readonly onSwitchWindow: () => void;
}) {
  const gt = useGT();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mjpegRef = useRef<HTMLImageElement | null>(null);
  const imeInputRef = useRef<HTMLTextAreaElement | null>(null);
  const clientRef = useRef<HostWindowStreamClient | null>(null);
  const lastClickRef = useRef<{
    ts: number;
    x: number;
    y: number;
    count: number;
    button: HostWindowMouseButton;
  }>({ ts: 0, x: 0, y: 0, count: 0, button: "left" });
  const composingRef = useRef(false);
  const pendingMoveRef = useRef<HostWindowInputCommand | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const pendingWheelRef = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: number;
  } | null>(null);
  const wheelRafRef = useRef<number | null>(null);
  const activeTouchesRef = useRef<Map<number, TrackedTouch>>(new Map());
  const touchSessionRef = useRef<TouchSessionState>({
    phase: "idle",
    maxFingers: 0,
    startTime: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    twoStartMidX: 0,
    twoStartMidY: 0,
    twoLastMidX: 0,
    twoLastMidY: 0,
    twoStartDist: 0,
    twoStartViewport: DEFAULT_VIEWPORT,
    threeStartY: 0,
    panStartX: 0,
    panStartY: 0,
    longPressTimer: null,
  });
  const virtualCursorRef = useRef<NormalizedPoint>({ x: 0.5, y: 0.5 });
  const viewportRef = useRef<ViewportTransform>(DEFAULT_VIEWPORT);
  const rippleIdRef = useRef(0);
  const rippleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickyModsRef = useRef(0);

  const [status, setStatus] = useState<HostWindowStreamStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [mjpegMode, setMjpegMode] = useState(false);
  const [preferMjpeg, setPreferMjpeg] = useState(false);
  const [inputConnected, setInputConnected] = useState(false);
  const [screen, setScreen] = useState<HostWindowScreenMeta | null>(null);
  const [stats, setStats] = useState<HostWindowStreamStats | null>(null);
  const [touchDevice, setTouchDevice] = useState(() => isTouchFirstDevice());
  const [touchMode, setTouchMode] = useState<TouchControlMode>("trackpad");
  const [lastInputKind, setLastInputKind] = useState<"mouse" | "touch">(() =>
    isTouchFirstDevice() ? "touch" : "mouse",
  );
  const [hostCursor, setHostCursor] = useState<HostWindowCursorShape | null>(null);
  const [virtualCursor, setVirtualCursor] = useState<NormalizedPoint>({ x: 0.5, y: 0.5 });
  const [isTouchDragging, setIsTouchDragging] = useState(false);
  const [viewport, setViewport] = useState<ViewportTransform>(DEFAULT_VIEWPORT);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [stickyMods, setStickyMods] = useState(0);
  const [showGestureGuide, setShowGestureGuide] = useState(false);
  const [ripple, setRipple] = useState<TouchFeedbackRipple | null>(null);

  const clearLongPressTimer = () => {
    const timer = touchSessionRef.current.longPressTimer;
    if (timer !== null) {
      clearTimeout(timer);
      touchSessionRef.current.longPressTimer = null;
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- manages WebCodecs/WebSocket host window stream lifecycle while mounted and visible.
  useEffect(() => {
    if (!props.visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const client = createHostWindowStreamClient(
      {
        kind: props.target.kind,
        id: props.target.id,
        access: props.access,
        preferMjpeg,
      },
      canvas,
      {
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          setStatusDetail(detail ?? null);
        },
        onScreen: (meta) => setScreen(meta),
        onStats: (nextStats) => setStats(nextStats),
        onCursor: (cursor) => setHostCursor(cursor),
        onMjpegFallback: () => {
          setMjpegMode(true);
          if (mjpegRef.current) client.setMjpegImage(mjpegRef.current);
        },
        onCanvasVideo: () => setMjpegMode(false),
        onInputConnected: (connected) => setInputConnected(connected),
        onUnauthorized: () => refreshHostWindowAccess(props.environmentId),
      },
    );
    clientRef.current = client;
    if (mjpegRef.current) client.setMjpegImage(mjpegRef.current);
    client.start();

    return () => {
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current);
      if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current);
      const timer = touchSessionRef.current.longPressTimer;
      if (timer !== null) clearTimeout(timer);
      touchSessionRef.current.longPressTimer = null;
      touchSessionRef.current.phase = "idle";
      activeTouchesRef.current.clear();
      moveRafRef.current = null;
      wheelRafRef.current = null;
      rippleTimerRef.current = null;
      pendingMoveRef.current = null;
      pendingWheelRef.current = null;
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [
    props.access,
    props.environmentId,
    props.target.id,
    props.target.kind,
    props.visible,
    preferMjpeg,
  ]);

  const sendInput = (command: HostWindowInputCommand) => {
    clientRef.current?.sendInput(command);
  };

  const activeMediaElement = (): HTMLElement | null =>
    mjpegMode ? mjpegRef.current : canvasRef.current;

  const updateViewport = (next: ViewportTransform) => {
    viewportRef.current = next;
    setViewport(next);
  };

  const resetViewport = () => {
    updateViewport(DEFAULT_VIEWPORT);
  };

  const updateVirtualCursor = (next: NormalizedPoint) => {
    virtualCursorRef.current = next;
    setVirtualCursor(next);
  };

  const triggerRipple = (point: NormalizedPoint, kind: "left" | "right" | "drag") => {
    const id = ++rippleIdRef.current;
    setRipple({ id, x: point.x, y: point.y, kind });
    if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = setTimeout(() => {
      rippleTimerRef.current = null;
      setRipple((curr) => (curr?.id === id ? null : curr));
    }, 320);
  };

  const queueMove = (command: HostWindowInputCommand) => {
    pendingMoveRef.current = command;
    if (moveRafRef.current === null) {
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null;
        const cmd = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (cmd) clientRef.current?.sendInput(cmd);
      });
    }
  };

  const queueWheel = (x: number, y: number, deltaX: number, deltaY: number, modifiers: number) => {
    const prev = pendingWheelRef.current;
    pendingWheelRef.current = {
      x,
      y,
      deltaX: (prev?.deltaX ?? 0) + deltaX,
      deltaY: (prev?.deltaY ?? 0) + deltaY,
      modifiers,
    };
    if (wheelRafRef.current === null) {
      wheelRafRef.current = requestAnimationFrame(() => {
        wheelRafRef.current = null;
        const wheel = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (wheel) clientRef.current?.sendInput({ type: "wheel", ...wheel });
      });
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a native non-passive wheel listener to the stage DOM node so preventDefault stops browser scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onNativeWheel = (event: WheelEvent) => {
      const mediaEl = mjpegMode ? mjpegRef.current : canvasRef.current;
      if (!mediaEl) return;
      const point = normalizedPointFromRect(
        mediaEl.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      const dx = normalizeWheelDelta(event.deltaX, event.deltaMode);
      const dy = normalizeWheelDelta(event.deltaY, event.deltaMode);
      if (dx === 0 && dy === 0) return;
      const prev = pendingWheelRef.current;
      pendingWheelRef.current = {
        x: point.x,
        y: point.y,
        deltaX: (prev?.deltaX ?? 0) + dx,
        deltaY: (prev?.deltaY ?? 0) + dy,
        modifiers: hostWindowModifiers(event),
      };
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = null;
          const wheel = pendingWheelRef.current;
          pendingWheelRef.current = null;
          if (wheel) clientRef.current?.sendInput({ type: "wheel", ...wheel });
        });
      }
    };
    stage.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onNativeWheel);
    };
  }, [mjpegMode]);

  const computeClickCount = (
    x: number,
    y: number,
    button: HostWindowMouseButton,
    maxDistance: number,
    now: number,
  ): number => {
    const prev = lastClickRef.current;
    const count =
      prev.button === button &&
      now - prev.ts < DOUBLE_TAP_WINDOW_MS &&
      Math.hypot(x - prev.x, y - prev.y) < maxDistance
        ? prev.count + 1
        : 1;
    lastClickRef.current = { ts: now, x, y, count, button };
    return count;
  };

  const sendClickAt = (point: NormalizedPoint, button: HostWindowMouseButton, clickCount = 1) => {
    const modifiers = stickyModsRef.current;
    sendInput({
      type: "mouse",
      action: "down",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    });
    sendInput({
      type: "mouse",
      action: "up",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    });
    triggerRipple(point, button === "right" ? "right" : "left");
    if (modifiers !== 0) {
      stickyModsRef.current = 0;
      setStickyMods(0);
    }
  };

  const openSoftKeyboard = () => {
    setKeyboardOpen(true);
    imeInputRef.current?.focus({ preventScroll: true });
  };

  const closeSoftKeyboard = () => {
    setKeyboardOpen(false);
    imeInputRef.current?.blur();
    stageRef.current?.focus({ preventScroll: true });
  };

  const toggleSoftKeyboard = () => {
    if (keyboardOpen) {
      closeSoftKeyboard();
    } else {
      openSoftKeyboard();
    }
  };

  const toggleStickyModifier = (bit: number) => {
    const next = stickyModsRef.current ^ bit;
    stickyModsRef.current = next;
    setStickyMods(next);
    if (keyboardOpen) {
      imeInputRef.current?.focus({ preventScroll: true });
    }
  };

  const consumeEffectiveModifiers = (eventMods: number): number => {
    const combined = eventMods | stickyModsRef.current;
    if (stickyModsRef.current !== 0) {
      stickyModsRef.current = 0;
      setStickyMods(0);
    }
    return combined;
  };

  const focusForPointer = (pointerType: string) => {
    if (!touchDevice && pointerType === "mouse") {
      imeInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!keyboardOpen) {
      stageRef.current?.focus({ preventScroll: true });
    }
  };

  const releaseLeftDragIfNeeded = () => {
    if (touchSessionRef.current.phase !== "left-dragging") return;
    const pt = virtualCursorRef.current;
    sendInput({
      type: "mouse",
      action: "up",
      x: pt.x,
      y: pt.y,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    });
    setIsTouchDragging(false);
  };

  const beginTwoFingerSession = (now: number) => {
    const touches = Array.from(activeTouchesRef.current.values());
    if (touches.length < 2) return;
    const [a, b] = touches;
    if (!a || !b) return;
    clearLongPressTimer();
    releaseLeftDragIfNeeded();
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const session = touchSessionRef.current;
    session.phase = "two-finger-pending";
    session.maxFingers = Math.max(session.maxFingers, 2);
    session.startTime = now;
    session.twoStartMidX = midX;
    session.twoStartMidY = midY;
    session.twoLastMidX = midX;
    session.twoLastMidY = midY;
    session.twoStartDist = Math.max(dist, 1);
    session.twoStartViewport = viewportRef.current;
  };

  const beginThreeFingerSession = () => {
    const touches = Array.from(activeTouchesRef.current.values());
    if (touches.length < 3) return;
    clearLongPressTimer();
    releaseLeftDragIfNeeded();
    const avgY = touches.reduce((sum, t) => sum + t.y, 0) / touches.length;
    const session = touchSessionRef.current;
    session.phase = "three-finger-pending";
    session.maxFingers = Math.max(session.maxFingers, 3);
    session.threeStartY = avgY;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, [data-host-overlay='true']")) {
      return;
    }
    event.preventDefault();
    if (showGestureGuide) setShowGestureGuide(false);
    if (event.pointerType === "touch" && !touchDevice) {
      setTouchDevice(true);
    }
    focusForPointer(event.pointerType);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}

    const mediaEl = activeMediaElement();
    if (!mediaEl) return;

    if (event.pointerType === "touch") {
      if (lastInputKind !== "touch") {
        setLastInputKind("touch");
        setVirtualCursor(virtualCursorRef.current);
      }
      const touches = activeTouchesRef.current;
      touches.set(event.pointerId, {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
      });

      if (touches.size >= 3) {
        beginThreeFingerSession();
        return;
      }
      if (touches.size === 2) {
        beginTwoFingerSession(event.timeStamp);
        return;
      }

      // Single finger down
      const session = touchSessionRef.current;
      clearLongPressTimer();
      session.phase = "single-pending";
      session.maxFingers = 1;
      session.startTime = event.timeStamp;
      session.startX = event.clientX;
      session.startY = event.clientY;
      session.lastX = event.clientX;
      session.lastY = event.clientY;
      session.panStartX = viewportRef.current.panX;
      session.panStartY = viewportRef.current.panY;

      // Tap-and-hold (quick second touch after a tap) immediately engages drag in trackpad mode.
      const prevClick = lastClickRef.current;
      const isQuickSecondTouch =
        touchMode === "trackpad" &&
        prevClick.button === "left" &&
        event.timeStamp - prevClick.ts < DOUBLE_TAP_WINDOW_MS;

      const longPressDelay = isQuickSecondTouch ? 200 : LONG_PRESS_MS;
      session.longPressTimer = setTimeout(() => {
        session.longPressTimer = null;
        if (session.phase !== "single-pending" || activeTouchesRef.current.size !== 1) return;

        if (touchMode === "trackpad") {
          // UU Remote pointer mode: long-press engages left-button drag at the virtual cursor.
          const pt = virtualCursorRef.current;
          session.phase = "left-dragging";
          setIsTouchDragging(true);
          triggerRipple(pt, "drag");
          sendInput({
            type: "mouse",
            action: "down",
            x: pt.x,
            y: pt.y,
            button: "left",
            clickCount: 1,
            modifiers: stickyModsRef.current,
          });
          return;
        }

        // Direct mode: long-press arms drag-or-right-click (lift = right-click, move = left-drag).
        const el = activeMediaElement();
        if (!el) return;
        const pt = normalizedPointFromRect(
          el.getBoundingClientRect(),
          session.startX,
          session.startY,
        );
        if (!pt) return;
        session.phase = "long-press-ready";
        triggerRipple(pt, "right");
      }, longPressDelay);
      return;
    }

    // Physical mouse or stylus: always direct 1:1 native desktop input.
    if (lastInputKind !== "mouse") {
      setLastInputKind("mouse");
    }
    const point = normalizedPointFromRect(
      mediaEl.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    virtualCursorRef.current = point;
    const button = mouseButtonName(event.button);
    const count = computeClickCount(event.clientX, event.clientY, button, 6, event.timeStamp);
    const modifiers = consumeEffectiveModifiers(hostWindowModifiers(event));
    sendInput({
      type: "mouse",
      action: "down",
      x: point.x,
      y: point.y,
      button,
      clickCount: count,
      modifiers,
    });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const mediaEl = activeMediaElement();
    if (!mediaEl) return;

    if (event.pointerType === "touch") {
      if (lastInputKind !== "touch") {
        setLastInputKind("touch");
        setVirtualCursor(virtualCursorRef.current);
      }
      const touches = activeTouchesRef.current;
      const tracked = touches.get(event.pointerId);
      if (!tracked) return;
      tracked.x = event.clientX;
      tracked.y = event.clientY;

      const session = touchSessionRef.current;

      // 3-finger vertical swipe: up = toggle keyboard, down = close keyboard / reset zoom.
      if (session.phase === "three-finger-pending" && touches.size >= 3) {
        const list = Array.from(touches.values());
        const avgY = list.reduce((sum, t) => sum + t.y, 0) / list.length;
        const dy = avgY - session.threeStartY;
        if (dy < -THREE_FINGER_SWIPE_THRESHOLD_PX) {
          session.phase = "three-finger-done";
          toggleSoftKeyboard();
        } else if (dy > THREE_FINGER_SWIPE_THRESHOLD_PX) {
          session.phase = "three-finger-done";
          if (keyboardOpen) {
            closeSoftKeyboard();
          } else if (viewportRef.current.zoom > 1.01) {
            resetViewport();
          }
        }
        return;
      }

      // 2-finger gestures: parallel slide = scroll wheel, pinch/spread = zoom & pan.
      if (
        touches.size === 2 &&
        (session.phase === "two-finger-pending" ||
          session.phase === "two-finger-scroll" ||
          session.phase === "two-finger-pinch")
      ) {
        const list = Array.from(touches.values());
        const a = list[0];
        const b = list[1];
        if (!a || !b) return;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);

        if (session.phase === "two-finger-pending") {
          const distDelta = Math.abs(dist - session.twoStartDist);
          const midDelta = Math.hypot(midX - session.twoStartMidX, midY - session.twoStartMidY);
          if (distDelta >= TWO_FINGER_PINCH_THRESHOLD_PX && distDelta > midDelta * 0.65) {
            session.phase = "two-finger-pinch";
          } else if (midDelta >= TWO_FINGER_SCROLL_THRESHOLD_PX) {
            session.phase = "two-finger-scroll";
          } else {
            return;
          }
        }

        if (session.phase === "two-finger-pinch") {
          const stageRect = stageRef.current?.getBoundingClientRect();
          if (!stageRect) return;
          const next = computePinchTransform({
            startZoom: session.twoStartViewport.zoom,
            startPanX: session.twoStartViewport.panX,
            startPanY: session.twoStartViewport.panY,
            startMidX: session.twoStartMidX,
            startMidY: session.twoStartMidY,
            currMidX: midX,
            currMidY: midY,
            scaleRatio: dist / session.twoStartDist,
            stageCenterX: stageRect.left + stageRect.width / 2,
            stageCenterY: stageRect.top + stageRect.height / 2,
            stageWidth: stageRect.width,
            stageHeight: stageRect.height,
          });
          updateViewport(next);
          return;
        }

        if (session.phase === "two-finger-scroll") {
          const dx = (session.twoLastMidX - midX) * TOUCH_SCROLL_MULTIPLIER;
          const dy = (session.twoLastMidY - midY) * TOUCH_SCROLL_MULTIPLIER;
          session.twoLastMidX = midX;
          session.twoLastMidY = midY;
          const anchor =
            touchMode === "trackpad"
              ? virtualCursorRef.current
              : normalizedPointFromRect(mediaEl.getBoundingClientRect(), midX, midY);
          if (anchor && (dx !== 0 || dy !== 0)) {
            queueWheel(anchor.x, anchor.y, dx, dy, stickyModsRef.current);
          }
        }
        return;
      }

      if (touches.size !== 1) return;

      const mediaRect = mediaEl.getBoundingClientRect();
      const dxPx = event.clientX - session.lastX;
      const dyPx = event.clientY - session.lastY;
      const totalDist = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);

      if (session.phase === "single-pending" && totalDist >= SINGLE_TAP_MAX_DIST_PX) {
        clearLongPressTimer();
        if (touchMode === "trackpad") {
          session.phase = "trackpad-move";
        } else if (viewportRef.current.zoom > 1.02) {
          session.phase = "direct-pan";
        } else {
          session.phase = "direct-scroll";
        }
      } else if (session.phase === "long-press-ready" && totalDist >= SINGLE_TAP_MAX_DIST_PX) {
        // Direct mode long-press followed by drag => left-button drag.
        const startPt = normalizedPointFromRect(mediaRect, session.startX, session.startY);
        if (startPt) {
          session.phase = "left-dragging";
          updateVirtualCursor(startPt);
          setIsTouchDragging(true);
          sendInput({
            type: "mouse",
            action: "down",
            x: startPt.x,
            y: startPt.y,
            button: "left",
            clickCount: 1,
            modifiers: stickyModsRef.current,
          });
        }
      }

      session.lastX = event.clientX;
      session.lastY = event.clientY;

      if (session.phase === "trackpad-move") {
        const nextCursor = applyTrackpadDelta(
          virtualCursorRef.current,
          dxPx,
          dyPx,
          mediaRect.width,
          mediaRect.height,
        );
        updateVirtualCursor(nextCursor);
        queueMove({
          type: "mouse",
          action: "move",
          x: nextCursor.x,
          y: nextCursor.y,
          button: "none",
          modifiers: stickyModsRef.current,
        });
        return;
      }

      if (session.phase === "left-dragging") {
        const nextPt =
          touchMode === "trackpad"
            ? applyTrackpadDelta(
                virtualCursorRef.current,
                dxPx,
                dyPx,
                mediaRect.width,
                mediaRect.height,
              )
            : normalizedPointFromRect(mediaRect, event.clientX, event.clientY);
        if (nextPt) {
          updateVirtualCursor(nextPt);
          queueMove({
            type: "mouse",
            action: "move",
            x: nextPt.x,
            y: nextPt.y,
            button: "left",
            modifiers: stickyModsRef.current,
          });
        }
        return;
      }

      if (session.phase === "direct-pan") {
        const stageRect = stageRef.current?.getBoundingClientRect();
        if (!stageRect) return;
        const next = clampViewportPan(
          session.panStartX + (event.clientX - session.startX),
          session.panStartY + (event.clientY - session.startY),
          viewportRef.current.zoom,
          stageRect.width,
          stageRect.height,
        );
        updateViewport(next);
        return;
      }

      if (session.phase === "direct-scroll") {
        const anchor = normalizedPointFromRect(mediaRect, session.startX, session.startY);
        if (anchor && (dxPx !== 0 || dyPx !== 0)) {
          queueWheel(
            anchor.x,
            anchor.y,
            -dxPx * TOUCH_SCROLL_MULTIPLIER,
            -dyPx * TOUCH_SCROLL_MULTIPLIER,
            stickyModsRef.current,
          );
        }
      }
      return;
    }

    // Physical mouse or stylus move
    if (lastInputKind !== "mouse") {
      setLastInputKind("mouse");
    }
    const point = normalizedPointFromRect(
      mediaEl.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    virtualCursorRef.current = point;
    const button: HostWindowMouseButton =
      event.buttons & 1
        ? "left"
        : event.buttons & 2
          ? "right"
          : event.buttons & 4
            ? "middle"
            : "none";
    queueMove({
      type: "mouse",
      action: "move",
      x: point.x,
      y: point.y,
      button,
      modifiers: hostWindowModifiers(event),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}

    const mediaEl = activeMediaElement();

    if (event.pointerType === "touch") {
      if (lastInputKind !== "touch") {
        setLastInputKind("touch");
        setVirtualCursor(virtualCursorRef.current);
      }
      const touches = activeTouchesRef.current;
      touches.delete(event.pointerId);
      const session = touchSessionRef.current;

      if (touches.size > 0) {
        // Still fingers remaining: keep current multi-touch phase until all lift.
        return;
      }

      clearLongPressTimer();
      const elapsed = event.timeStamp - session.startTime;
      const isCleanUp = event.type === "pointerup";

      if (session.phase === "left-dragging") {
        releaseLeftDragIfNeeded();
      } else if (
        isCleanUp &&
        session.phase === "two-finger-pending" &&
        elapsed <= TWO_FINGER_TAP_MAX_MS
      ) {
        const moved = Math.hypot(
          session.twoLastMidX - session.twoStartMidX,
          session.twoLastMidY - session.twoStartMidY,
        );
        if (moved <= TWO_FINGER_TAP_MAX_DIST_PX && mediaEl) {
          // UU Remote signature gesture: 2-finger tap = right click.
          const pt =
            touchMode === "trackpad"
              ? virtualCursorRef.current
              : normalizedPointFromRect(
                  mediaEl.getBoundingClientRect(),
                  session.twoStartMidX,
                  session.twoStartMidY,
                );
          if (pt) sendClickAt(pt, "right", 1);
        }
      } else if (isCleanUp && session.phase === "long-press-ready" && mediaEl) {
        // Direct mode long-press without dragging = right click.
        const pt = normalizedPointFromRect(
          mediaEl.getBoundingClientRect(),
          session.startX,
          session.startY,
        );
        if (pt) sendClickAt(pt, "right", 1);
      } else if (
        isCleanUp &&
        session.phase === "single-pending" &&
        session.maxFingers === 1 &&
        elapsed <= SINGLE_TAP_MAX_MS &&
        mediaEl
      ) {
        if (touchMode === "trackpad") {
          const pt = virtualCursorRef.current;
          const count = computeClickCount(pt.x * 1000, pt.y * 1000, "left", 40, event.timeStamp);
          sendClickAt(pt, "left", count);
        } else {
          const pt = normalizedPointFromRect(
            mediaEl.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
          if (pt) {
            const count = computeClickCount(
              event.clientX,
              event.clientY,
              "left",
              24,
              event.timeStamp,
            );
            sendClickAt(pt, "left", count);
          }
        }
      }

      session.phase = "idle";
      session.maxFingers = 0;
      return;
    }

    if (!mediaEl) return;
    const point = normalizedPointFromRect(
      mediaEl.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    sendInput({
      type: "mouse",
      action: "up",
      x: point.x,
      y: point.y,
      button: mouseButtonName(event.button),
      clickCount: lastClickRef.current.count,
      modifiers: hostWindowModifiers(event),
    });
  };

  const sendShortcut = (code: string, modifiers: number) => {
    const effective = consumeEffectiveModifiers(modifiers);
    sendInput({ type: "key", action: "down", code, modifiers: effective });
    sendInput({ type: "key", action: "up", code, modifiers: effective });
  };

  const handleHardwareKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target === imeInputRef.current) return;
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.key === "Unidentified"
    ) {
      return;
    }
    event.preventDefault();
    sendInput({
      type: "key",
      action: "down",
      key: event.key,
      code: event.code,
      modifiers: consumeEffectiveModifiers(hostWindowModifiers(event)),
    });
  };

  const handleHardwareKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target === imeInputRef.current) return;
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.key === "Unidentified"
    ) {
      return;
    }
    event.preventDefault();
    sendInput({
      type: "key",
      action: "up",
      key: event.key,
      code: event.code,
      modifiers: hostWindowModifiers(event),
    });
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendInput({ type: "clipboard", text, paste: true });
        return;
      }
    } catch {}
    sendShortcut("KeyV", 4);
  };

  const mediaWidth =
    stats && stats.width > 0 ? stats.width : screen && screen.width > 0 ? screen.width : 0;
  const mediaHeight =
    stats && stats.height > 0 ? stats.height : screen && screen.height > 0 ? screen.height : 0;
  const resolutionLabel = mediaWidth > 0 && mediaHeight > 0 ? `${mediaWidth}×${mediaHeight}` : null;
  const mediaAspectRatio = mediaWidth > 0 && mediaHeight > 0 ? mediaWidth / mediaHeight : null;

  const showVirtualCursor =
    touchDevice && touchMode === "trackpad" && lastInputKind === "touch" && status === "streaming";
  const isZoomed = viewport.zoom > 1.01;
  const cssCursor = hostCursor
    ? `url("${hostCursor.dataUrl}") ${hostCursor.hotspotX} ${hostCursor.hotspotY}, default`
    : "default";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">
            {props.target.appName}
            {props.target.title && props.target.title !== props.target.appName
              ? `: ${props.target.title}`
              : ""}
          </span>
          {resolutionLabel ? (
            <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground sm:inline">
              {resolutionLabel}
              {stats && !mjpegMode ? (
                <T>
                  {" "}
                  · <Var>{stats.fps}</Var> fps
                </T>
              ) : null}
            </span>
          ) : null}
          {!inputConnected && status === "streaming" ? (
            <span className="shrink-0 text-3xs text-warning">
              <T>Controls reconnecting…</T>
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isZoomed ? (
            <Button
              size="xs"
              variant="secondary"
              title={gt("Reset zoom to 100%")}
              onClick={resetViewport}
            >
              <span className="font-mono text-3xs">{viewport.zoom.toFixed(1)}×</span>
            </Button>
          ) : null}
          {touchDevice ? (
            <>
              <Button
                size="xs"
                variant="secondary"
                title={
                  touchMode === "trackpad"
                    ? gt("Pointer mode (tap to switch to direct touch)")
                    : gt("Direct touch mode (tap to switch to pointer mode)")
                }
                onClick={() =>
                  setTouchMode((prev) => (prev === "trackpad" ? "direct" : "trackpad"))
                }
              >
                {touchMode === "trackpad" ? (
                  <>
                    <MousePointer2 className="mr-1 size-3" />
                    <span className="text-3xs">
                      <T>Pointer</T>
                    </span>
                  </>
                ) : (
                  <>
                    <Hand className="mr-1 size-3" />
                    <span className="text-3xs">
                      <T>Touch</T>
                    </span>
                  </>
                )}
              </Button>
              <Button
                size="xs"
                variant={showGestureGuide ? "secondary" : "ghost"}
                title={gt("Touch gestures guide")}
                onClick={() => setShowGestureGuide((prev) => !prev)}
              >
                <HelpCircle className="size-3.5" />
              </Button>
            </>
          ) : null}
          <Button
            size="xs"
            variant={keyboardOpen ? "secondary" : "ghost"}
            title={keyboardOpen ? gt("Hide keyboard") : gt("Show keyboard")}
            onClick={toggleSoftKeyboard}
          >
            <Keyboard className="size-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Focus window on host")}
            onClick={() => sendInput({ type: "focus" })}
          >
            <Focus className="size-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Send ⌘L (Address bar)")}
            onClick={() => sendShortcut("KeyL", 4)}
          >
            <span className="font-mono text-2xs">⌘L</span>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Reload (⌘R)")}
            onClick={() => sendShortcut("KeyR", 4)}
          >
            <RefreshCw className="size-3" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Paste clipboard (⌘V)")}
            onClick={() => void handlePasteClipboard()}
          >
            <ClipboardPaste className="size-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Send Escape")}
            onClick={() => sendShortcut("Escape", 0)}
          >
            <CornerDownLeft className="size-3" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={gt("Toggle H.264 / MJPEG mode")}
            onClick={() => setPreferMjpeg((prev) => !prev)}
          >
            <span className="font-mono text-3xs">{mjpegMode ? "MJPEG" : "H.264"}</span>
          </Button>
          <Button size="xs" variant="outline" onClick={props.onSwitchWindow}>
            <Layers className="mr-1 size-3" />
            <T>Switch</T>
          </Button>
        </div>
      </div>

      <div
        ref={stageRef}
        tabIndex={0}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/95 outline-none select-none"
        style={{ touchAction: "none", containerType: "size" }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleHardwareKeyDown}
        onKeyUp={handleHardwareKeyUp}
      >
        {status !== "streaming" ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 text-xs text-muted-foreground">
            {status === "connecting" ? <Spinner className="size-4" /> : null}
            <span>
              {statusDetail ??
                (status === "error"
                  ? gt("Host window stream unavailable.")
                  : gt("Connecting to host window…"))}
            </span>
          </div>
        ) : null}

        <div
          className="relative flex shrink-0 items-center justify-center"
          style={{
            width:
              mediaAspectRatio !== null
                ? `min(100cqw, calc(100cqh * ${mediaAspectRatio}))`
                : "100%",
            height:
              mediaAspectRatio !== null
                ? `min(100cqh, calc(100cqw / ${mediaAspectRatio}))`
                : "100%",
            transform: `translate3d(${viewport.panX}px, ${viewport.panY}px, 0) scale(${viewport.zoom})`,
            transformOrigin: "center center",
            willChange: isZoomed ? "transform" : undefined,
          }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={-1}
            className="size-full rounded-sm shadow-lg outline-none select-none"
            style={{
              display: mjpegMode ? "none" : "block",
              cursor: cssCursor,
            }}
          />

          <img
            ref={mjpegRef}
            alt={props.target.title}
            draggable={false}
            className="size-full rounded-sm object-contain shadow-lg outline-none select-none"
            style={{
              display: mjpegMode ? "block" : "none",
              cursor: cssCursor,
            }}
          />

          {ripple ? (
            <div
              key={ripple.id}
              className={`pointer-events-none absolute z-20 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 animate-ping ${
                ripple.kind === "left" ? "border-primary" : "border-warning"
              }`}
              style={{
                left: `${ripple.x * 100}%`,
                top: `${ripple.y * 100}%`,
              }}
            />
          ) : null}

          {showVirtualCursor ? (
            <div
              className="pointer-events-none absolute z-20"
              style={{
                left: `${virtualCursor.x * 100}%`,
                top: `${virtualCursor.y * 100}%`,
                transform: `scale(${1 / viewport.zoom})`,
                transformOrigin: "0 0",
              }}
            >
              {isTouchDragging ? (
                <div className="absolute -top-2.5 -left-2.5 size-6 rounded-full border-2 border-primary bg-primary/20" />
              ) : null}
              {hostCursor ? (
                <img
                  src={hostCursor.dataUrl}
                  alt=""
                  draggable={false}
                  width={hostCursor.width}
                  height={hostCursor.height}
                  className="pointer-events-none block max-w-none drop-shadow-sm"
                  style={{
                    marginLeft: -hostCursor.hotspotX,
                    marginTop: -hostCursor.hotspotY,
                  }}
                />
              ) : (
                <svg
                  width="18"
                  height="22"
                  viewBox="0 0 18 22"
                  fill="none"
                  className="drop-shadow-md"
                >
                  <path
                    d="M1.5 1.5L1.5 17.5L5.8 13.4L8.8 19.6L11.4 18.3L8.4 12.1L14.5 12.1L1.5 1.5Z"
                    className="fill-background stroke-foreground"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
          ) : null}
        </div>

        {showGestureGuide ? (
          <div
            data-host-overlay="true"
            className="absolute top-2 right-2 z-30 w-72 rounded-lg border bg-popover/95 p-3 text-xs text-popover-foreground shadow-lg backdrop-blur-sm"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold">
                {touchMode === "trackpad" ? (
                  <T>Pointer Mode Gestures</T>
                ) : (
                  <T>Direct Touch Gestures</T>
                )}
              </span>
              <Button
                size="xs"
                variant="ghost"
                title={gt("Close gestures guide")}
                onClick={() => setShowGestureGuide(false)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <ul className="space-y-1 text-2xs text-muted-foreground">
              {touchMode === "trackpad" ? (
                <>
                  <li>
                    <T>1-finger drag: Move cursor</T>
                  </li>
                  <li>
                    <T>1-finger tap / double-tap: Left click / double-click</T>
                  </li>
                  <li>
                    <T>1-finger long-press + drag: Left-button drag &amp; select</T>
                  </li>
                  <li>
                    <T>2-finger tap: Right click</T>
                  </li>
                  <li>
                    <T>2-finger drag: Scroll wheel</T>
                  </li>
                  <li>
                    <T>2-finger pinch: Zoom &amp; pan (1×–4×)</T>
                  </li>
                  <li>
                    <T>3-finger swipe up / down: Keyboard / Reset zoom</T>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <T>1-finger tap / double-tap: Left click / double-click</T>
                  </li>
                  <li>
                    <T>1-finger drag: Scroll (or pan when zoomed)</T>
                  </li>
                  <li>
                    <T>1-finger long-press: Right click (or drag to select)</T>
                  </li>
                  <li>
                    <T>2-finger tap: Right click</T>
                  </li>
                  <li>
                    <T>2-finger drag: Scroll wheel</T>
                  </li>
                  <li>
                    <T>2-finger pinch: Zoom &amp; pan (1×–4×)</T>
                  </li>
                  <li>
                    <T>3-finger swipe up / down: Keyboard / Reset zoom</T>
                  </li>
                </>
              )}
            </ul>
          </div>
        ) : null}

        {keyboardOpen ? (
          <div
            data-host-overlay="true"
            className="absolute inset-x-2 bottom-2 z-30 flex items-center gap-1 overflow-x-auto rounded-lg border bg-popover/95 px-2 py-1.5 shadow-lg backdrop-blur-sm"
          >
            {MODIFIER_KEYS.map((mod) => {
              const active = (stickyMods & mod.bit) !== 0;
              return (
                <Button
                  key={mod.label}
                  size="xs"
                  variant={active ? "default" : "outline"}
                  aria-label={mod.label}
                  onClick={() => toggleStickyModifier(mod.bit)}
                >
                  <span className="font-mono text-2xs">{mod.label}</span>
                </Button>
              );
            })}
            <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
            {QUICK_NAV_KEYS.map((item) => (
              <Button
                key={item.code}
                size="xs"
                variant="ghost"
                onClick={() => {
                  sendShortcut(item.code, 0);
                  imeInputRef.current?.focus({ preventScroll: true });
                }}
              >
                <span className="font-mono text-2xs">{item.label}</span>
              </Button>
            ))}
            <div className="ml-auto shrink-0">
              <Button
                size="xs"
                variant="ghost"
                title={gt("Hide keyboard")}
                onClick={closeSoftKeyboard}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : null}

        <textarea
          ref={imeInputRef}
          aria-label={gt("Host window keyboard input")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none fixed -left-[9999px] size-px opacity-0"
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            if (event.data) sendInput({ type: "text", text: event.data });
            event.currentTarget.value = "";
          }}
          onBeforeInput={(event) => {
            if (composingRef.current) return;
            const nativeEvent = event.nativeEvent as InputEvent;
            const inputType = nativeEvent.inputType;
            if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
              event.preventDefault();
              sendShortcut("Enter", 0);
              return;
            }
            if (inputType === "deleteContentBackward") {
              event.preventDefault();
              sendShortcut("Backspace", 0);
              return;
            }
            if (inputType === "deleteContentForward") {
              event.preventDefault();
              sendShortcut("Delete", 0);
              return;
            }
            if (inputType === "insertText" && nativeEvent.data) {
              event.preventDefault();
              const mods = stickyModsRef.current;
              if (mods !== 0 && nativeEvent.data.length === 1) {
                const ch = nativeEvent.data.toUpperCase();
                const code = /^[A-Z]$/.test(ch)
                  ? `Key${ch}`
                  : /^[0-9]$/.test(ch)
                    ? `Digit${ch}`
                    : undefined;
                if (code) {
                  sendShortcut(code, 0);
                  return;
                }
              }
              sendInput({ type: "text", text: nativeEvent.data });
            }
          }}
          onInput={(event) => {
            if (composingRef.current) return;
            const val = event.currentTarget.value;
            if (val) {
              sendInput({ type: "text", text: val });
              event.currentTarget.value = "";
            }
          }}
          onKeyDown={(event) => {
            if (
              composingRef.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.key === "Unidentified"
            ) {
              return;
            }
            event.preventDefault();
            sendInput({
              type: "key",
              action: "down",
              key: event.key,
              code: event.code,
              modifiers: consumeEffectiveModifiers(hostWindowModifiers(event)),
            });
          }}
          onKeyUp={(event) => {
            if (
              composingRef.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.key === "Unidentified"
            ) {
              return;
            }
            event.preventDefault();
            sendInput({
              type: "key",
              action: "up",
              key: event.key,
              code: event.code,
              modifiers: hostWindowModifiers(event),
            });
          }}
        />
      </div>
    </div>
  );
}
