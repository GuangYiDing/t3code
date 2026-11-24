import {
  createHostWindowStreamClient,
  type HostWindowActiveTransport,
  type HostWindowCursorShape,
  type HostWindowQualityPreset,
  type HostWindowStreamClient,
  type HostWindowTransportMode,
} from "@t3tools/client-runtime/host-window/stream";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";

export interface MobileHostWindowConfig {
  readonly kind: "window" | "display";
  readonly id: number;
  readonly access: DeviceHubAccess;
  readonly transport?: HostWindowTransportMode;
}

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
    __t3HostWindowStart?: (config: MobileHostWindowConfig) => void;
    __t3HostWindowCommand?: (cmd: {
      readonly type: string;
      readonly preset?: HostWindowQualityPreset;
      readonly mode?: "trackpad" | "direct";
      readonly audio?: boolean;
      readonly width?: number;
      readonly height?: number;
      readonly text?: string;
      readonly code?: string;
      readonly modifiers?: number;
    }) => void;
  }
}

const post = (payload: unknown) => {
  window.ReactNativeWebView?.postMessage(JSON.stringify(payload));
};

let activeClient: HostWindowStreamClient | null = null;
let touchMode: "trackpad" | "direct" = "trackpad";
let cursorPos = { x: 0.5, y: 0.5 };
let zoom = 1;
let panX = 0;
let panY = 0;

function startHostWindowStream(config: MobileHostWindowConfig) {
  activeClient?.stop();

  const stage = document.getElementById("stage") as HTMLDivElement;
  const wrap = document.getElementById("wrap") as HTMLDivElement;
  const video = document.getElementById("video") as HTMLVideoElement;
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const mjpeg = document.getElementById("mjpeg") as HTMLImageElement;
  const cursorEl = document.getElementById("cursor") as HTMLDivElement;
  const cursorImg = document.getElementById("cursor-img") as HTMLImageElement;

  let activeTransport: HostWindowActiveTransport = "webrtc";
  let mediaW = 0;
  let mediaH = 0;

  const updateFit = () => {
    if (mediaW <= 0 || mediaH <= 0) return;
    const ratio = mediaW / mediaH;
    wrap.style.width = `min(100cqw, calc(100cqh * ${ratio}))`;
    wrap.style.height = `min(100cqh, calc(100cqw / ${ratio}))`;
    wrap.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  };

  const renderCursor = () => {
    cursorEl.style.display = touchMode === "trackpad" ? "block" : "none";
    cursorEl.style.left = `${cursorPos.x * 100}%`;
    cursorEl.style.top = `${cursorPos.y * 100}%`;
    cursorEl.style.transform = `scale(${1 / zoom})`;
  };

  const applyCursorShape = (shape: HostWindowCursorShape) => {
    cursorImg.src = shape.dataUrl;
    cursorImg.width = shape.width;
    cursorImg.height = shape.height;
    cursorImg.style.marginLeft = `${-shape.hotspotX}px`;
    cursorImg.style.marginTop = `${-shape.hotspotY}px`;
  };

  const activeMediaEl = () =>
    activeTransport === "webrtc" ? video : activeTransport === "mjpeg" ? mjpeg : canvas;

  const setTransportDisplay = (transport: HostWindowActiveTransport) => {
    activeTransport = transport;
    video.style.display = transport === "webrtc" ? "block" : "none";
    canvas.style.display = transport === "avcc" ? "block" : "none";
    mjpeg.style.display = transport === "mjpeg" ? "block" : "none";
    post({ type: "transport", transport });
  };

  const client = createHostWindowStreamClient(
    {
      kind: config.kind,
      id: config.id,
      access: config.access,
      transport: config.transport ?? "auto",
    },
    canvas,
    {
      onStatus: (status, detail) => post({ type: "status", status, detail }),
      onScreen: (meta) => {
        mediaW = meta.width;
        mediaH = meta.height;
        updateFit();
        post({ type: "screen", meta });
      },
      onStats: (stats) => {
        if (stats.width > 0 && stats.height > 0) {
          mediaW = stats.width;
          mediaH = stats.height;
          updateFit();
        }
        post({ type: "stats", stats });
      },
      onCursor: applyCursorShape,
      onClipboard: (text) => post({ type: "clipboard", text }),
      onAudioState: (enabled) => post({ type: "audio", enabled }),
      onTransportChange: setTransportDisplay,
      onMjpegFallback: () => setTransportDisplay("mjpeg"),
      onCanvasVideo: () => setTransportDisplay("avcc"),
      onUnauthorized: () => post({ type: "unauthorized" }),
    },
  );
  activeClient = client;
  client.setVideoElement(video);
  client.setMjpegImage(mjpeg);
  renderCursor();

  const normPoint = (clientX: number, clientY: number) => {
    const r = activeMediaEl().getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    };
  };

  const touches = new Map<number, { x: number; y: number }>();
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let startTime = 0;
  let startDist = 1;
  let startZoom = 1;
  let phase: "idle" | "single" | "move" | "two" | "pinch" | "scroll" = "idle";

  stage.onpointerdown = (e) => {
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = Array.from(touches.values());
      if (a && b) {
        phase = "two";
        startTime = e.timeStamp;
        startX = (a.x + b.x) / 2;
        startY = (a.y + b.y) / 2;
        lastX = startX;
        lastY = startY;
        startDist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        startZoom = zoom;
      }
      return;
    }
    if (touches.size === 1) {
      phase = "single";
      startTime = e.timeStamp;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  };

  stage.onpointermove = (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    const rect = activeMediaEl().getBoundingClientRect();
    if (touches.size === 2 && (phase === "two" || phase === "pinch" || phase === "scroll")) {
      const [a, b] = Array.from(touches.values());
      if (!a || !b) return;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (phase === "two") {
        if (Math.abs(dist - startDist) > 18) phase = "pinch";
        else if (Math.hypot(midX - startX, midY - startY) > 12) phase = "scroll";
        else return;
      }
      if (phase === "pinch") {
        zoom = Math.max(1, Math.min(4, startZoom * (dist / startDist)));
        if (zoom <= 1.01) {
          zoom = 1;
          panX = 0;
          panY = 0;
        }
        updateFit();
        renderCursor();
      } else if (phase === "scroll") {
        const dx = (lastX - midX) * 1.5;
        const dy = (lastY - midY) * 1.5;
        lastX = midX;
        lastY = midY;
        const pt = touchMode === "trackpad" ? cursorPos : normPoint(midX, midY);
        if (pt)
          client.sendInput({
            type: "wheel",
            x: pt.x,
            y: pt.y,
            deltaX: dx,
            deltaY: dy,
            modifiers: 0,
          });
      }
      return;
    }
    if (touches.size === 1) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (phase === "single" && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
        phase = "move";
      }
      if (phase === "move") {
        if (touchMode === "trackpad" && rect.width > 0 && rect.height > 0) {
          const speed = Math.hypot(dx, dy);
          const gain = Math.min(2.0, 1.1 + speed * 0.03);
          cursorPos = {
            x: Math.max(0, Math.min(1, cursorPos.x + (dx * gain) / rect.width)),
            y: Math.max(0, Math.min(1, cursorPos.y + (dy * gain) / rect.height)),
          };
          renderCursor();
          client.sendInput({
            type: "mouse",
            action: "move",
            x: cursorPos.x,
            y: cursorPos.y,
            button: "none",
            modifiers: 0,
          });
        } else {
          const pt = normPoint(startX, startY);
          if (pt) {
            client.sendInput({
              type: "wheel",
              x: pt.x,
              y: pt.y,
              deltaX: -dx * 1.5,
              deltaY: -dy * 1.5,
              modifiers: 0,
            });
          }
        }
      }
    }
  };

  stage.onpointerup = stage.onpointercancel = (e) => {
    touches.delete(e.pointerId);
    if (touches.size > 0) return;
    const elapsed = e.timeStamp - startTime;
    if (e.type === "pointerup") {
      if (phase === "single" && elapsed < 360) {
        const pt = touchMode === "trackpad" ? cursorPos : normPoint(e.clientX, e.clientY);
        if (pt) {
          client.sendInput({
            type: "mouse",
            action: "down",
            x: pt.x,
            y: pt.y,
            button: "left",
            clickCount: 1,
            modifiers: 0,
          });
          client.sendInput({
            type: "mouse",
            action: "up",
            x: pt.x,
            y: pt.y,
            button: "left",
            clickCount: 1,
            modifiers: 0,
          });
        }
      } else if (phase === "two" && elapsed < 280) {
        const pt = touchMode === "trackpad" ? cursorPos : normPoint(startX, startY);
        if (pt) {
          client.sendInput({
            type: "mouse",
            action: "down",
            x: pt.x,
            y: pt.y,
            button: "right",
            clickCount: 1,
            modifiers: 0,
          });
          client.sendInput({
            type: "mouse",
            action: "up",
            x: pt.x,
            y: pt.y,
            button: "right",
            clickCount: 1,
            modifiers: 0,
          });
          post({ type: "haptic" });
        }
      }
    }
    phase = "idle";
  };

  window.__t3HostWindowCommand = (cmd) => {
    if (cmd.type === "mode" && cmd.mode) {
      touchMode = cmd.mode;
      renderCursor();
    } else if (cmd.type === "quality" && cmd.preset) {
      client.setQuality(cmd.preset);
    } else if (cmd.type === "audio") {
      if (cmd.audio) client.startAudio();
      else client.stopAudio();
    } else if (cmd.type === "fit") {
      const r = stage.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const ratio = r.width / r.height;
        const w = Math.min(1800, Math.max(800, Math.round(r.width * 1.5)));
        const h = Math.min(1200, Math.max(540, Math.round(w / ratio)));
        client.sendInput({ type: "resize", width: w, height: h });
      }
      zoom = 1;
      panX = 0;
      panY = 0;
      updateFit();
      renderCursor();
    } else if (cmd.type === "focus") {
      client.sendInput({ type: "focus" });
    } else if (cmd.type === "text" && cmd.text) {
      client.sendInput({ type: "text", text: cmd.text });
    } else if (cmd.type === "shortcut" && cmd.code) {
      client.sendInput({
        type: "key",
        action: "down",
        code: cmd.code,
        modifiers: cmd.modifiers ?? 0,
      });
      client.sendInput({
        type: "key",
        action: "up",
        code: cmd.code,
        modifiers: cmd.modifiers ?? 0,
      });
    }
  };

  client.start();
}

window.__t3HostWindowStart = startHostWindowStream;
