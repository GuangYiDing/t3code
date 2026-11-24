import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import {
  createHostWindowStreamClient,
  hostWindowModifiers,
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
  Keyboard,
  Layers,
  Monitor,
  MousePointerClick,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { HostWindowTabTarget } from "~/rightPanelStore";
import { refreshHostWindowAccess } from "~/state/hostWindow";

const mouseButtonName = (button: number): HostWindowMouseButton =>
  button === 2 ? "right" : button === 1 ? "middle" : "left";

const isTouchFirstDevice = (): boolean => {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(pointer: coarse)").matches) return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

const normalizeWheelDelta = (delta: number, deltaMode: number): number => {
  if (deltaMode === 1) return delta * 32; // DOM_DELTA_LINE
  if (deltaMode === 2) return delta * 400; // DOM_DELTA_PAGE
  return delta; // DOM_DELTA_PIXEL
};

const normalizedPoint = (el: HTMLElement, clientX: number, clientY: number) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
};

const TOUCH_DRAG_THRESHOLD_PX = 10;
const TOUCH_LONG_PRESS_MS = 500;
const TOUCH_SCROLL_MULTIPLIER = 1.4;

type TouchGestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  mode: "pending" | "scrolling" | "dragging" | "long-pressed";
  longPressTimer: ReturnType<typeof setTimeout> | null;
};

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
  const touchGestureRef = useRef<TouchGestureState | null>(null);

  const [status, setStatus] = useState<HostWindowStreamStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [mjpegMode, setMjpegMode] = useState(false);
  const [preferMjpeg, setPreferMjpeg] = useState(false);
  const [inputConnected, setInputConnected] = useState(false);
  const [screen, setScreen] = useState<HostWindowScreenMeta | null>(null);
  const [stats, setStats] = useState<HostWindowStreamStats | null>(null);
  const [touchDevice] = useState(() => isTouchFirstDevice());
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [touchMode, setTouchMode] = useState<"scroll" | "drag">("scroll");

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
      if (touchGestureRef.current?.longPressTimer) {
        clearTimeout(touchGestureRef.current.longPressTimer);
      }
      touchGestureRef.current = null;
      moveRafRef.current = null;
      wheelRafRef.current = null;
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
      const point = normalizedPoint(mediaEl, event.clientX, event.clientY);
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
    clientX: number,
    clientY: number,
    button: HostWindowMouseButton,
    maxDistance: number,
  ): number => {
    const now = performance.now();
    const prev = lastClickRef.current;
    const count =
      prev.button === button &&
      now - prev.ts < 450 &&
      Math.hypot(clientX - prev.x, clientY - prev.y) < maxDistance
        ? prev.count + 1
        : 1;
    lastClickRef.current = { ts: now, x: clientX, y: clientY, count, button };
    return count;
  };

  const focusForPointer = (pointerType: string) => {
    if (!touchDevice && pointerType === "mouse") {
      // Desktop mouse click: focus hidden IME textarea for zero-friction typing & CJK IME.
      imeInputRef.current?.focus({ preventScroll: true });
      return;
    }
    // Tablet / mobile / touch: never auto-focus <textarea>, otherwise Android/iOS pops up the
    // virtual keyboard on every click. Focus the non-editable stage so physical/Bluetooth
    // keyboards still work without opening the soft keyboard.
    if (!keyboardOpen) {
      stageRef.current?.focus({ preventScroll: true });
    }
  };

  const clearTouchTimer = (gesture: TouchGestureState | null) => {
    if (gesture?.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    focusForPointer(event.pointerType);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;

    if (event.pointerType === "touch" && touchMode === "scroll") {
      clearTouchTimer(touchGestureRef.current);
      const targetEl = event.currentTarget;
      const startX = event.clientX;
      const startY = event.clientY;
      const modifiers = hostWindowModifiers(event);
      const gesture: TouchGestureState = {
        pointerId: event.pointerId,
        startX,
        startY,
        lastX: startX,
        lastY: startY,
        startTime: performance.now(),
        mode: "pending",
        longPressTimer: setTimeout(() => {
          const current = touchGestureRef.current;
          if (!current || current.pointerId !== event.pointerId || current.mode !== "pending") {
            return;
          }
          current.mode = "long-pressed";
          current.longPressTimer = null;
          const pt = normalizedPoint(targetEl, current.startX, current.startY);
          if (!pt) return;
          sendInput({
            type: "mouse",
            action: "down",
            x: pt.x,
            y: pt.y,
            button: "right",
            clickCount: 1,
            modifiers,
          });
          sendInput({
            type: "mouse",
            action: "up",
            x: pt.x,
            y: pt.y,
            button: "right",
            clickCount: 1,
            modifiers,
          });
        }, TOUCH_LONG_PRESS_MS),
      };
      touchGestureRef.current = gesture;
      return;
    }

    const button = mouseButtonName(event.button);
    const count = computeClickCount(event.clientX, event.clientY, button, 6);
    sendInput({
      type: "mouse",
      action: "down",
      x: point.x,
      y: point.y,
      button,
      clickCount: count,
      modifiers: hostWindowModifiers(event),
    });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" && touchMode === "scroll") {
      const gesture = touchGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (gesture.mode === "long-pressed") return;
      const totalDist = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (gesture.mode === "pending" && totalDist >= TOUCH_DRAG_THRESHOLD_PX) {
        clearTouchTimer(gesture);
        gesture.mode = "scrolling";
      }
      if (gesture.mode === "scrolling") {
        const dx = (gesture.lastX - event.clientX) * TOUCH_SCROLL_MULTIPLIER;
        const dy = (gesture.lastY - event.clientY) * TOUCH_SCROLL_MULTIPLIER;
        gesture.lastX = event.clientX;
        gesture.lastY = event.clientY;
        const anchor = normalizedPoint(event.currentTarget, gesture.startX, gesture.startY);
        if (anchor && (dx !== 0 || dy !== 0)) {
          queueWheel(anchor.x, anchor.y, dx, dy, hostWindowModifiers(event));
        }
      }
      return;
    }

    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const button: HostWindowMouseButton =
      event.buttons & 1
        ? "left"
        : event.buttons & 2
          ? "right"
          : event.buttons & 4
            ? "middle"
            : "none";
    pendingMoveRef.current = {
      type: "mouse",
      action: "move",
      x: point.x,
      y: point.y,
      button,
      modifiers: hostWindowModifiers(event),
    };
    if (moveRafRef.current === null) {
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null;
        const cmd = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (cmd) sendInput(cmd);
      });
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}

    if (event.pointerType === "touch" && touchMode === "scroll") {
      const gesture = touchGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      clearTouchTimer(gesture);
      touchGestureRef.current = null;
      if (gesture.mode === "pending" && event.type === "pointerup") {
        const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
        if (!point) return;
        const count = computeClickCount(event.clientX, event.clientY, "left", 24);
        const modifiers = hostWindowModifiers(event);
        sendInput({
          type: "mouse",
          action: "down",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: count,
          modifiers,
        });
        sendInput({
          type: "mouse",
          action: "up",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: count,
          modifiers,
        });
      }
      return;
    }

    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
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
    sendInput({ type: "key", action: "down", code, modifiers });
    sendInput({ type: "key", action: "up", code, modifiers });
  };

  const toggleSoftKeyboard = () => {
    if (keyboardOpen) {
      setKeyboardOpen(false);
      imeInputRef.current?.blur();
      stageRef.current?.focus({ preventScroll: true });
      return;
    }
    setKeyboardOpen(true);
    imeInputRef.current?.focus({ preventScroll: true });
  };

  const handleHardwareKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target === imeInputRef.current) return;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    sendInput({
      type: "key",
      action: "down",
      key: event.key,
      code: event.code,
      modifiers: hostWindowModifiers(event),
    });
  };

  const handleHardwareKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target === imeInputRef.current) return;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
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

  const resolutionLabel =
    stats && stats.width > 0 && stats.height > 0
      ? `${stats.width}×${stats.height}`
      : screen
        ? `${screen.width}×${screen.height}`
        : null;

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
          <Button
            size="xs"
            variant={keyboardOpen ? "secondary" : "ghost"}
            title={keyboardOpen ? gt("Hide keyboard") : gt("Show keyboard")}
            onClick={toggleSoftKeyboard}
          >
            <Keyboard className="size-3.5" />
          </Button>
          {touchDevice ? (
            <Button
              size="xs"
              variant={touchMode === "drag" ? "secondary" : "ghost"}
              title={
                touchMode === "scroll"
                  ? gt("Touch: Scroll (tap to switch to drag)")
                  : gt("Touch: Drag (tap to switch to scroll)")
              }
              onClick={() => setTouchMode((prev) => (prev === "scroll" ? "drag" : "scroll"))}
            >
              {touchMode === "scroll" ? (
                <Hand className="size-3.5" />
              ) : (
                <MousePointerClick className="size-3.5" />
              )}
            </Button>
          ) : null}
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
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/95 p-1 outline-none"
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

        <canvas
          ref={canvasRef}
          tabIndex={-1}
          className="max-h-full max-w-full cursor-default rounded-sm shadow-lg outline-none select-none"
          style={{
            display: mjpegMode ? "none" : "block",
            width: "auto",
            height: "auto",
            touchAction: "none",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        <img
          ref={mjpegRef}
          alt={props.target.title}
          draggable={false}
          className="max-h-full max-w-full cursor-default rounded-sm shadow-lg outline-none select-none"
          style={{
            display: mjpegMode ? "block" : "none",
            width: "auto",
            height: "auto",
            touchAction: "none",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        <textarea
          ref={imeInputRef}
          aria-label={gt("Host window keyboard input")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="pointer-events-none fixed -left-[9999px] size-px opacity-0"
          onBlur={() => setKeyboardOpen(false)}
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
              modifiers: hostWindowModifiers(event),
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
