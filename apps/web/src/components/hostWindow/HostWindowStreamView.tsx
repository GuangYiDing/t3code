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
import { ClipboardPaste, CornerDownLeft, Focus, Layers, Monitor, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { HostWindowTabTarget } from "~/rightPanelStore";
import { refreshHostWindowAccess } from "~/state/hostWindow";

const mouseButtonName = (button: number): HostWindowMouseButton =>
  button === 2 ? "right" : button === 1 ? "middle" : "left";

export function HostWindowStreamView(props: {
  readonly environmentId: EnvironmentId;
  readonly target: HostWindowTabTarget;
  readonly access: DeviceHubAccess;
  readonly visible: boolean;
  readonly onSwitchWindow: () => void;
}) {
  const gt = useGT();
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

  const [status, setStatus] = useState<HostWindowStreamStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [mjpegMode, setMjpegMode] = useState(false);
  const [preferMjpeg, setPreferMjpeg] = useState(false);
  const [inputConnected, setInputConnected] = useState(false);
  const [screen, setScreen] = useState<HostWindowScreenMeta | null>(null);
  const [stats, setStats] = useState<HostWindowStreamStats | null>(null);

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

  const normalizedPoint = (el: HTMLElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    imeInputRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const button = mouseButtonName(event.button);
    const now = performance.now();
    const prev = lastClickRef.current;
    const count =
      prev.button === button &&
      now - prev.ts < 450 &&
      Math.hypot(event.clientX - prev.x, event.clientY - prev.y) < 6
        ? prev.count + 1
        : 1;
    lastClickRef.current = { ts: now, x: event.clientX, y: event.clientY, count, button };
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
    sendInput({
      type: "mouse",
      action: "move",
      x: point.x,
      y: point.y,
      button,
      modifiers: hostWindowModifiers(event),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
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

  const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
    const point = normalizedPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    sendInput({
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: hostWindowModifiers(event),
    });
  };

  const sendShortcut = (code: string, modifiers: number) => {
    sendInput({ type: "key", action: "down", code, modifiers });
    sendInput({ type: "key", action: "up", code, modifiers });
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/90 p-2">
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
          tabIndex={0}
          className="max-h-full max-w-full cursor-default rounded-md object-contain shadow-lg outline-none select-none"
          style={{ display: mjpegMode ? "none" : "block", touchAction: "none" }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />

        <img
          ref={mjpegRef}
          alt={props.target.title}
          draggable={false}
          className="max-h-full max-w-full cursor-default rounded-md object-contain shadow-lg outline-none select-none"
          style={{ display: mjpegMode ? "block" : "none", touchAction: "none" }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />

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
          onKeyDown={(event) => {
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
          }}
          onKeyUp={(event) => {
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
          }}
        />
      </div>
    </div>
  );
}
