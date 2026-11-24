// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - Browser streaming transport runs outside Effect.
import { createCanvasFrameSink } from "../device/frame.ts";
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import { AvccDemuxer, avcCodecString } from "../device/stream.ts";

export type HostWindowStreamStatus = "connecting" | "streaming" | "error";

export interface HostWindowScreenMeta {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly title?: string | null;
  readonly appName?: string | null;
}

export interface HostWindowStreamStats {
  readonly fps: number;
  readonly kbps: number;
  readonly width: number;
  readonly height: number;
}

export interface HostWindowStreamTarget {
  readonly kind: "window" | "display";
  readonly id: number;
  readonly access: DeviceHubAccess;
  readonly preferMjpeg?: boolean;
}

export interface HostWindowStreamEvents {
  readonly onStatus: (status: HostWindowStreamStatus, detail?: string) => void;
  readonly onScreen?: (meta: HostWindowScreenMeta) => void;
  readonly onStats?: (stats: HostWindowStreamStats) => void;
  readonly onMjpegFallback: (url: string) => void;
  readonly onCanvasVideo?: () => void;
  readonly onInputConnected?: (connected: boolean) => void;
  readonly onUnauthorized: () => void;
}

export type HostWindowMouseButton = "left" | "right" | "middle" | "none";

export type HostWindowInputCommand =
  | {
      readonly type: "mouse";
      readonly action: "down" | "up" | "move";
      readonly x: number;
      readonly y: number;
      readonly button: HostWindowMouseButton;
      readonly clickCount?: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key?: string;
      readonly code?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "clipboard"; readonly text: string; readonly paste?: boolean }
  | { readonly type: "focus" };

export interface HostWindowStreamClient {
  readonly start: () => void;
  readonly stop: () => void;
  readonly setMjpegImage: (image: HTMLImageElement | null) => void;
  readonly sendInput: (command: HostWindowInputCommand) => boolean;
}

const RETRY_DELAY_MS = 1_200;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const FRAME_DURATION_US = 16_667;
const SOFT_DECODE_QUEUE = 2;

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

export function hostWindowModifiers(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export function createHostWindowStreamClient(
  target: HostWindowStreamTarget,
  canvas: HTMLCanvasElement,
  events: HostWindowStreamEvents,
): HostWindowStreamClient {
  const sink = createCanvasFrameSink(canvas);
  const pathBase = `/${target.kind}/${target.id}`;
  const httpUrl = (suffix: string) =>
    withDeviceHubQuery(`${target.access.httpBase}${pathBase}${suffix}`, target.access);
  const wsUrl = (suffix: string) =>
    withDeviceHubQuery(`${target.access.wsBase}${pathBase}${suffix}`, target.access);

  const useWebCodecs = isWebCodecsSupported() && !target.preferMjpeg;

  let stopped = true;
  let videoAbort: AbortController | null = null;
  let decoder: VideoDecoder | null = null;
  let awaitingKey = true;
  let timestamp = 0;
  let socket: WebSocket | null = null;
  let videoRetry: ReturnType<typeof setTimeout> | null = null;
  let inputRetry: ReturnType<typeof setTimeout> | null = null;
  let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let mjpegMode = false;
  let mjpegImage: HTMLImageElement | null = null;
  let releaseImage: (() => void) | null = null;
  let hasFrame = false;
  let framesSinceTick = 0;
  let bytesSinceTick = 0;
  let lastTick = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  const closeDecoder = () => {
    try {
      decoder?.close();
    } catch {}
    decoder = null;
    awaitingKey = true;
  };

  const clearFirstFrameTimer = () => {
    if (firstFrameTimer !== null) clearTimeout(firstFrameTimer);
    firstFrameTimer = null;
  };

  const markStreaming = () => {
    if (!hasFrame && !stopped) {
      hasFrame = true;
      clearFirstFrameTimer();
      events.onStatus("streaming");
    }
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    lastWidth = width;
    lastHeight = height;
    sink.present(source, width, height);
    framesSinceTick++;
    markStreaming();
  };

  const attachMjpeg = () => {
    releaseImage?.();
    releaseImage = null;
    const img = mjpegImage;
    if (!img || stopped || !mjpegMode) return;
    const onLoad = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        lastWidth = img.naturalWidth;
        lastHeight = img.naturalHeight;
        markStreaming();
      }
    };
    const onError = () => {
      if (!stopped) events.onStatus("error", "Could not load host window MJPEG stream.");
    };
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    releaseImage = () => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      img.removeAttribute("src");
    };
    img.src = httpUrl("/stream.mjpeg");
  };

  const fallBackToMjpeg = () => {
    if (stopped || mjpegMode) return;
    mjpegMode = true;
    videoAbort?.abort();
    videoAbort = null;
    closeDecoder();
    events.onMjpegFallback(httpUrl("/stream.mjpeg"));
    attachMjpeg();
  };

  const configureDecoder = async (description: Uint8Array) => {
    const config: VideoDecoderConfig = {
      codec: avcCodecString(description),
      description,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (stopped) return;
    if (!support.supported) {
      fallBackToMjpeg();
      return;
    }
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => {
        try {
          paint(frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (!stopped) fallBackToMjpeg();
      },
    });
    decoder.configure(config);
    awaitingKey = true;
  };

  const connectVideo = async () => {
    if (stopped) return;
    if (!useWebCodecs) {
      fallBackToMjpeg();
      return;
    }
    events.onCanvasVideo?.();
    const ac = new AbortController();
    videoAbort = ac;
    const demuxer = new AvccDemuxer();
    let decodedAny = false;

    try {
      const response = await fetch(httpUrl("/stream.avcc"), {
        signal: ac.signal,
        credentials: target.access.credentials ? "include" : "same-origin",
      });
      if (stopped || ac.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        stop();
        events.onUnauthorized();
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Stream HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped || ac.signal.aborted) break;
        bytesSinceTick += value.byteLength;
        for (const chunk of demuxer.push(value)) {
          if (stopped || ac.signal.aborted) break;
          if (chunk.type === "seed" && !decodedAny) {
            void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
              .then((bitmap) => {
                try {
                  if (!stopped && !decodedAny) paint(bitmap, bitmap.width, bitmap.height);
                } finally {
                  bitmap.close();
                }
              })
              .catch(() => {});
          } else if (chunk.type === "description") {
            await configureDecoder(chunk.payload);
          } else if (chunk.type === "keyframe" || chunk.type === "delta") {
            if (!decoder || decoder.state !== "configured") continue;
            const isKey = chunk.type === "keyframe";
            if (awaitingKey && !isKey) continue;
            awaitingKey = false;
            if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) continue;
            decoder.decode(
              new EncodedVideoChunk({
                type: isKey ? "key" : "delta",
                timestamp,
                data: chunk.payload,
              }),
            );
            decodedAny = true;
            timestamp += FRAME_DURATION_US;
          } else if (chunk.type === "end") {
            events.onStatus("error", "Window stream ended.");
            return;
          }
        }
      }
      if (!stopped && !ac.signal.aborted && !mjpegMode) {
        events.onStatus("connecting", "Reconnecting stream…");
        videoRetry = setTimeout(() => {
          videoRetry = null;
          void connectVideo();
        }, RETRY_DELAY_MS);
      }
    } catch (error) {
      if (stopped || ac.signal.aborted || mjpegMode) return;
      events.onStatus("connecting", error instanceof Error ? error.message : "Reconnecting…");
      videoRetry = setTimeout(() => {
        videoRetry = null;
        void connectVideo();
      }, RETRY_DELAY_MS);
    }
  };

  const connectInput = () => {
    if (stopped) return;
    try {
      const ws = new WebSocket(wsUrl("/input"));
      socket = ws;
      ws.addEventListener("open", () => {
        if (socket !== ws || stopped) return;
        events.onInputConnected?.(true);
      });
      ws.addEventListener("message", (event) => {
        if (socket !== ws || stopped || typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as {
            type?: string;
            width?: number;
            height?: number;
            scale?: number;
            title?: string;
            appName?: string;
          };
          if (
            parsed.type === "screen" &&
            typeof parsed.width === "number" &&
            typeof parsed.height === "number"
          ) {
            events.onScreen?.({
              width: parsed.width,
              height: parsed.height,
              scale: parsed.scale ?? 1,
              title: parsed.title ?? null,
              appName: parsed.appName ?? null,
            });
          }
        } catch {}
      });
      ws.addEventListener("close", () => {
        if (socket !== ws) return;
        socket = null;
        events.onInputConnected?.(false);
        if (!stopped) {
          inputRetry = setTimeout(() => {
            inputRetry = null;
            connectInput();
          }, RETRY_DELAY_MS);
        }
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
    } catch {
      events.onInputConnected?.(false);
    }
  };

  const stop = () => {
    stopped = true;
    hasFrame = false;
    mjpegMode = false;
    if (videoRetry !== null) clearTimeout(videoRetry);
    if (inputRetry !== null) clearTimeout(inputRetry);
    clearFirstFrameTimer();
    if (statsTimer !== null) clearInterval(statsTimer);
    videoRetry = null;
    inputRetry = null;
    statsTimer = null;
    videoAbort?.abort();
    videoAbort = null;
    closeDecoder();
    releaseImage?.();
    releaseImage = null;
    socket?.close();
    socket = null;
    events.onInputConnected?.(false);
  };

  const start = () => {
    stop();
    stopped = false;
    lastTick = performance.now();
    framesSinceTick = 0;
    bytesSinceTick = 0;
    events.onStatus("connecting");
    firstFrameTimer = setTimeout(() => {
      if (stopped || hasFrame) return;
      events.onStatus(
        "error",
        "No video received from this window. Make sure it is visible (not minimized) or pick another window.",
      );
    }, FIRST_FRAME_TIMEOUT_MS);
    statsTimer = setInterval(() => {
      if (stopped) return;
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      if (dt > 0) {
        events.onStats?.({
          fps: Math.round(framesSinceTick / dt),
          kbps: Math.round((bytesSinceTick * 8) / dt / 1000),
          width: lastWidth,
          height: lastHeight,
        });
      }
      framesSinceTick = 0;
      bytesSinceTick = 0;
      lastTick = now;
    }, 1000);
    connectInput();
    void connectVideo();
  };

  const sendInput = (command: HostWindowInputCommand): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  };

  return {
    start,
    stop,
    setMjpegImage(image) {
      if (mjpegImage === image) return;
      releaseImage?.();
      releaseImage = null;
      mjpegImage = image;
      attachMjpeg();
    },
    sendInput,
  };
}
