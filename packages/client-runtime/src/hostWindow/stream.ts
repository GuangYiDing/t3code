// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - Browser streaming transport runs outside Effect.
import { createCanvasFrameSink } from "../device/frame.ts";
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import { AvccDemuxer, avcCodecString } from "../device/stream.ts";

export type HostWindowStreamStatus = "connecting" | "streaming" | "error";

export type HostWindowQualityPreset = "speed" | "balanced" | "crisp";

export type HostWindowTransportMode = "auto" | "webrtc" | "avcc" | "mjpeg";

export type HostWindowActiveTransport = "webrtc" | "avcc" | "mjpeg";

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

export interface HostWindowCursorShape {
  readonly dataUrl: string;
  readonly hotspotX: number;
  readonly hotspotY: number;
  readonly width: number;
  readonly height: number;
}

export interface HostWindowVirtualDisplay {
  readonly id: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface HostWindowStreamTarget {
  readonly kind: "window" | "display";
  readonly id: number;
  readonly access: DeviceHubAccess;
  readonly preferMjpeg?: boolean;
  readonly transport?: HostWindowTransportMode;
}

export interface HostWindowStreamEvents {
  readonly onStatus: (status: HostWindowStreamStatus, detail?: string) => void;
  readonly onScreen?: (meta: HostWindowScreenMeta) => void;
  readonly onStats?: (stats: HostWindowStreamStats) => void;
  readonly onCursor?: (cursor: HostWindowCursorShape) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onAudioState?: (enabled: boolean) => void;
  readonly onTransportChange?: (transport: HostWindowActiveTransport) => void;
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
  | { readonly type: "focus" }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "quality"; readonly preset: HostWindowQualityPreset }
  | { readonly type: "keyframe" };

export interface HostWindowStreamClient {
  readonly start: () => void;
  readonly stop: () => void;
  readonly setMjpegImage: (image: HTMLImageElement | null) => void;
  readonly setVideoElement: (video: HTMLVideoElement | null) => void;
  readonly sendInput: (command: HostWindowInputCommand) => boolean;
  readonly setQuality: (preset: HostWindowQualityPreset) => boolean;
  readonly requestKeyframe: () => boolean;
  readonly startAudio: () => void;
  readonly stopAudio: () => void;
  readonly uploadFile: (file: File) => Promise<{ ok: boolean; filename: string; bytes: number }>;
}

const RETRY_DELAY_MS = 1_200;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const WEBRTC_ICE_GATHER_MS = 1_400;
const WEBRTC_CONNECT_TIMEOUT_MS = 3_500;
const FRAME_DURATION_US = 16_667;
const SOFT_DECODE_QUEUE = 2;
const KEYFRAME_REQUEST_COOLDOWN_MS = 500;

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

const isWebRtcSupported = (): boolean =>
  typeof globalThis !== "undefined" && typeof globalThis.RTCPeerConnection === "function";

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

export async function createHostVirtualDisplay(
  access: DeviceHubAccess,
  options: {
    readonly width: number;
    readonly height: number;
    readonly hiDPI?: boolean;
    readonly name?: string;
  },
): Promise<HostWindowVirtualDisplay> {
  const url = withDeviceHubQuery(`${access.httpBase}/displays/virtual`, access);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: access.credentials ? "include" : "same-origin",
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(`Could not create virtual display (HTTP ${res.status})`);
  }
  return (await res.json()) as HostWindowVirtualDisplay;
}

export async function deleteHostVirtualDisplay(
  access: DeviceHubAccess,
  displayId: number,
): Promise<boolean> {
  const url = withDeviceHubQuery(`${access.httpBase}/displays/virtual/${displayId}`, access);
  const res = await fetch(url, {
    method: "DELETE",
    credentials: access.credentials ? "include" : "same-origin",
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return data.ok === true;
}

function waitForBrowserIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
  });
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
  const rootHttpUrl = (path: string) =>
    withDeviceHubQuery(`${target.access.httpBase}${path}`, target.access);
  const wsUrl = (suffix: string) =>
    withDeviceHubQuery(`${target.access.wsBase}${pathBase}${suffix}`, target.access);

  const requestedTransport: HostWindowTransportMode =
    target.transport ?? (target.preferMjpeg ? "mjpeg" : "auto");

  let stopped = true;
  let videoAbort: AbortController | null = null;
  let decoder: VideoDecoder | null = null;
  let awaitingKey = true;
  let timestamp = 0;
  let socket: WebSocket | null = null;
  let audioSocket: WebSocket | null = null;
  let audioCtx: AudioContext | null = null;
  let audioNextPlayTime = 0;
  let audioSampleRate = 48_000;
  let audioChannels = 2;
  let peer: RTCPeerConnection | null = null;
  let webrtcSessionId: string | null = null;
  let webrtcWatchdog: ReturnType<typeof setTimeout> | null = null;
  let webrtcStream: MediaStream | null = null;
  let webrtcLastBytes = 0;
  let videoElement: HTMLVideoElement | null = null;
  let releaseVideo: (() => void) | null = null;
  let videoRetry: ReturnType<typeof setTimeout> | null = null;
  let inputRetry: ReturnType<typeof setTimeout> | null = null;
  let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let activeTransport: HostWindowActiveTransport = "avcc";
  let mjpegMode = false;
  let mjpegImage: HTMLImageElement | null = null;
  let releaseImage: (() => void) | null = null;
  let hasFrame = false;
  let framesSinceTick = 0;
  let bytesSinceTick = 0;
  let lastTick = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastKeyframeRequestAt = 0;
  let activeQuality: HostWindowQualityPreset = "balanced";

  const setActiveTransport = (next: HostWindowActiveTransport) => {
    activeTransport = next;
    events.onTransportChange?.(next);
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

  const requestKeyframe = (): boolean => {
    const now = performance.now();
    if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return false;
    lastKeyframeRequestAt = now;
    return sendInput({ type: "keyframe" });
  };

  const setQuality = (preset: HostWindowQualityPreset): boolean => {
    activeQuality = preset;
    return sendInput({ type: "quality", preset });
  };

  const closeDecoder = () => {
    try {
      decoder?.close();
    } catch {}
    decoder = null;
    awaitingKey = true;
  };

  const closeWebRtc = () => {
    if (webrtcWatchdog !== null) clearTimeout(webrtcWatchdog);
    webrtcWatchdog = null;
    releaseVideo?.();
    releaseVideo = null;
    if (videoElement && videoElement.srcObject === webrtcStream) {
      videoElement.srcObject = null;
    }
    webrtcStream = null;
    webrtcLastBytes = 0;
    const sessionId = webrtcSessionId;
    webrtcSessionId = null;
    if (sessionId) {
      void fetch(rootHttpUrl(`/webrtc/${sessionId}`), {
        method: "DELETE",
        credentials: target.access.credentials ? "include" : "same-origin",
      }).catch(() => {});
    }
    try {
      peer?.close();
    } catch {}
    peer = null;
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

  const attachWebRtcVideo = () => {
    releaseVideo?.();
    releaseVideo = null;
    const video = videoElement;
    if (!video || !webrtcStream || stopped || activeTransport !== "webrtc") return;
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        lastWidth = video.videoWidth;
        lastHeight = video.videoHeight;
        if (webrtcWatchdog !== null) {
          clearTimeout(webrtcWatchdog);
          webrtcWatchdog = null;
        }
        markStreaming();
      }
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    video.addEventListener("resize", onReady);
    releaseVideo = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("resize", onReady);
    };
    video.srcObject = webrtcStream;
    void video.play().catch(() => {});
    onReady();
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
    closeWebRtc();
    videoAbort?.abort();
    videoAbort = null;
    closeDecoder();
    setActiveTransport("mjpeg");
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
    if (!isWebCodecsSupported() || requestedTransport === "mjpeg") {
      fallBackToMjpeg();
      return;
    }
    closeWebRtc();
    setActiveTransport("avcc");
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
            if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
              awaitingKey = true;
              requestKeyframe();
              continue;
            }
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
      if (!stopped && !ac.signal.aborted && !mjpegMode && activeTransport === "avcc") {
        events.onStatus("connecting", "Reconnecting stream…");
        videoRetry = setTimeout(() => {
          videoRetry = null;
          void connectVideo();
        }, RETRY_DELAY_MS);
      }
    } catch (error) {
      if (stopped || ac.signal.aborted || mjpegMode || activeTransport !== "avcc") return;
      events.onStatus("connecting", error instanceof Error ? error.message : "Reconnecting…");
      videoRetry = setTimeout(() => {
        videoRetry = null;
        void connectVideo();
      }, RETRY_DELAY_MS);
    }
  };

  const fallbackFromWebRtc = () => {
    if (stopped) return;
    closeWebRtc();
    if (requestedTransport === "webrtc") {
      events.onStatus("connecting", "Reconnecting WebRTC…");
      videoRetry = setTimeout(() => {
        videoRetry = null;
        void connectWebRtc();
      }, RETRY_DELAY_MS);
      return;
    }
    void connectVideo();
  };

  const connectWebRtc = async () => {
    if (stopped) return;
    if (!isWebRtcSupported()) {
      void connectVideo();
      return;
    }
    closeWebRtc();
    setActiveTransport("webrtc");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peer = pc;

    webrtcWatchdog = setTimeout(() => {
      if (peer === pc && !hasFrame && !stopped) {
        fallbackFromWebRtc();
      }
    }, WEBRTC_CONNECT_TIMEOUT_MS);

    pc.addEventListener("track", (event) => {
      if (peer !== pc || stopped) return;
      webrtcStream = event.streams[0] ?? new MediaStream([event.track]);
      attachWebRtcVideo();
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (peer !== pc || stopped) return;
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        fallbackFromWebRtc();
      }
    });

    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      if (peer !== pc || stopped) return;
      await pc.setLocalDescription(offer);
      await waitForBrowserIceGathering(pc, WEBRTC_ICE_GATHER_MS);
      if (peer !== pc || stopped) return;

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        fallbackFromWebRtc();
        return;
      }

      const res = await fetch(httpUrl("/webrtc/offer"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: target.access.credentials ? "include" : "same-origin",
        body: JSON.stringify({ type: "offer", sdp: localSdp }),
      });
      if (peer !== pc || stopped) return;
      if (res.status === 401 || res.status === 403) {
        stop();
        events.onUnauthorized();
        return;
      }
      if (!res.ok) {
        fallbackFromWebRtc();
        return;
      }
      const answer = (await res.json()) as { type?: string; sdp?: string; sessionId?: string };
      if (peer !== pc || stopped || !answer.sdp) {
        fallbackFromWebRtc();
        return;
      }
      webrtcSessionId = answer.sessionId ?? null;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch {
      if (peer === pc && !stopped) {
        fallbackFromWebRtc();
      }
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
        if (activeQuality !== "balanced") {
          sendInput({ type: "quality", preset: activeQuality });
        }
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
            dataUrl?: string;
            hotspotX?: number;
            hotspotY?: number;
            text?: string;
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
          } else if (
            parsed.type === "cursor" &&
            typeof parsed.dataUrl === "string" &&
            typeof parsed.width === "number" &&
            typeof parsed.height === "number"
          ) {
            events.onCursor?.({
              dataUrl: parsed.dataUrl,
              hotspotX: parsed.hotspotX ?? 0,
              hotspotY: parsed.hotspotY ?? 0,
              width: parsed.width,
              height: parsed.height,
            });
          } else if (parsed.type === "clipboard" && typeof parsed.text === "string") {
            events.onClipboard?.(parsed.text);
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

  const stopAudio = () => {
    try {
      audioSocket?.close();
    } catch {}
    audioSocket = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    audioNextPlayTime = 0;
    events.onAudioState?.(false);
  };

  const playPcmChunk = (raw: ArrayBuffer) => {
    const ctx = audioCtx;
    if (!ctx || raw.byteLength < 4) return;
    const channels = Math.max(1, audioChannels);
    const totalSamples = Math.floor(raw.byteLength / 2);
    const frameCount = Math.floor(totalSamples / channels);
    if (frameCount <= 0) return;

    const view = new DataView(raw);
    const buffer = ctx.createBuffer(channels, frameCount, audioSampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        const sample = view.getInt16((i * channels + ch) * 2, true);
        channelData[i] = sample / 32768;
      }
    }

    const now = ctx.currentTime;
    if (audioNextPlayTime < now + 0.015 || audioNextPlayTime > now + 0.16) {
      audioNextPlayTime = now + 0.03;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(audioNextPlayTime);
    audioNextPlayTime += buffer.duration;
  };

  const startAudio = () => {
    if (stopped || audioSocket) return;
    const AudioContextCtor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      const ctx = new AudioContextCtor({ latencyHint: "interactive" });
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      audioCtx = ctx;
      audioNextPlayTime = 0;

      const ws = new WebSocket(wsUrl("/audio"));
      ws.binaryType = "arraybuffer";
      audioSocket = ws;
      ws.addEventListener("open", () => {
        if (audioSocket === ws && !stopped) events.onAudioState?.(true);
      });
      ws.addEventListener("message", (event) => {
        if (audioSocket !== ws || stopped) return;
        if (typeof event.data === "string") {
          try {
            const parsed = JSON.parse(event.data) as {
              type?: string;
              sampleRate?: number;
              channels?: number;
            };
            if (parsed.type === "audio-meta") {
              if (typeof parsed.sampleRate === "number" && parsed.sampleRate > 0) {
                audioSampleRate = parsed.sampleRate;
              }
              if (typeof parsed.channels === "number" && parsed.channels > 0) {
                audioChannels = parsed.channels;
              }
            }
          } catch {}
        } else if (event.data instanceof ArrayBuffer) {
          playPcmChunk(event.data);
        }
      });
      ws.addEventListener("close", () => {
        if (audioSocket === ws) stopAudio();
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
    } catch {
      stopAudio();
    }
  };

  const uploadFile = async (
    file: File,
  ): Promise<{ ok: boolean; filename: string; bytes: number }> => {
    const res = await fetch(httpUrl("/upload"), {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name || "upload.bin"),
      },
      credentials: target.access.credentials ? "include" : "same-origin",
      body: file,
    });
    if (!res.ok) {
      throw new Error(`Upload failed (HTTP ${res.status})`);
    }
    return (await res.json()) as { ok: boolean; filename: string; bytes: number };
  };

  const onVisibilityChange = () => {
    if (!stopped && typeof document !== "undefined" && document.visibilityState === "visible") {
      requestKeyframe();
    }
  };

  const stop = () => {
    stopped = true;
    hasFrame = false;
    mjpegMode = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (videoRetry !== null) clearTimeout(videoRetry);
    if (inputRetry !== null) clearTimeout(inputRetry);
    clearFirstFrameTimer();
    if (statsTimer !== null) clearInterval(statsTimer);
    videoRetry = null;
    inputRetry = null;
    statsTimer = null;
    closeWebRtc();
    videoAbort?.abort();
    videoAbort = null;
    closeDecoder();
    releaseImage?.();
    releaseImage = null;
    stopAudio();
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
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
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
      lastTick = now;
      if (activeTransport === "webrtc" && peer) {
        void peer
          .getStats()
          .then((report) => {
            if (stopped || activeTransport !== "webrtc") return;
            report.forEach((stat) => {
              const s = stat as {
                type?: string;
                kind?: string;
                bytesReceived?: number;
                framesPerSecond?: number;
                frameWidth?: number;
                frameHeight?: number;
              };
              if (s.type === "inbound-rtp" && s.kind === "video") {
                const bytes = s.bytesReceived ?? 0;
                const deltaBytes = Math.max(0, bytes - webrtcLastBytes);
                webrtcLastBytes = bytes;
                const w = s.frameWidth ?? videoElement?.videoWidth ?? lastWidth;
                const h = s.frameHeight ?? videoElement?.videoHeight ?? lastHeight;
                if (w > 0 && h > 0) {
                  lastWidth = w;
                  lastHeight = h;
                }
                events.onStats?.({
                  fps: Math.round(s.framesPerSecond ?? 0),
                  kbps: dt > 0 ? Math.round((deltaBytes * 8) / dt / 1000) : 0,
                  width: lastWidth,
                  height: lastHeight,
                });
              }
            });
          })
          .catch(() => {});
        return;
      }
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
    }, 1000);
    connectInput();
    if (requestedTransport === "mjpeg") {
      fallBackToMjpeg();
    } else if (requestedTransport === "avcc") {
      void connectVideo();
    } else {
      void connectWebRtc();
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
    setVideoElement(video) {
      if (videoElement === video) return;
      releaseVideo?.();
      releaseVideo = null;
      videoElement = video;
      attachWebRtcVideo();
    },
    sendInput,
    setQuality,
    requestKeyframe,
    startAudio,
    stopAudio,
    uploadFile,
  };
}
