// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off globalRandom:off - Manages native UDP WebRTC peer sessions bridged from the loopback AVCC stream.
import {
  H264Packetizer,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  parseAvcDecoderConfigurationRecord,
  useAbsSendTime,
  useSdesMid,
  useTransportWideCC,
} from "werift";

export interface HostWindowWebRtcTarget {
  readonly helperOrigin: string;
  readonly helperToken: string;
  readonly targetPath: string; // e.g. "/window/171" or "/display/1"
}

export interface HostWindowWebRtcAnswer {
  readonly type: "answer";
  readonly sdp: string;
  readonly sessionId: string;
}

const AVCC_TAG_DESCRIPTION = 1;
const AVCC_TAG_KEYFRAME = 2;
const AVCC_TAG_DELTA = 3;
const AVCC_TAG_END = 7;

const ICE_GATHER_TIMEOUT_MS = 1_200;
const BITRATE_UPDATE_COOLDOWN_MS = 1_000;
const KEYFRAME_PLI_COOLDOWN_MS = 250;
const H264_CLOCK_RATE = 90_000;

interface ActiveWebRtcSession {
  readonly close: () => void;
}

const activeSessions = new Map<string, ActiveWebRtcSession>();

function makeH264Codecs(): RTCRtpCodecParameters[] {
  const feedback = [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "ccm", parameter: "fir" },
    { type: "goog-remb" },
    { type: "transport-cc" },
  ];
  return [
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: H264_CLOCK_RATE,
      rtcpFeedback: feedback,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    }),
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: H264_CLOCK_RATE,
      rtcpFeedback: feedback,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d002a",
    }),
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: H264_CLOCK_RATE,
      rtcpFeedback: feedback,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64002a",
    }),
  ];
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") finish();
    });
  });
}

async function postHelperControl(
  target: HostWindowWebRtcTarget,
  suffix: string,
  body?: unknown,
): Promise<void> {
  try {
    await fetch(`${target.helperOrigin}${target.targetPath}${suffix}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.helperToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {}
}

class FramedAvccReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Array<{ readonly tag: number; readonly payload: Buffer }> {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming]);
    const out: Array<{ readonly tag: number; readonly payload: Buffer }> = [];
    let offset = 0;
    while (this.buf.length - offset >= 4) {
      const len = this.buf.readUInt32BE(offset);
      if (this.buf.length - offset - 4 < len) break;
      if (len >= 1) {
        const tag = this.buf[offset + 4]!;
        const payload = this.buf.subarray(offset + 5, offset + 4 + len);
        out.push({ tag, payload });
      }
      offset += 4 + len;
    }
    if (offset > 0) {
      this.buf = offset === this.buf.length ? Buffer.alloc(0) : this.buf.subarray(offset);
    }
    return out;
  }
}

export async function createHostWindowWebRtcAnswer(params: {
  readonly target: HostWindowWebRtcTarget;
  readonly offerSdp: string;
  readonly iceServers?: ReadonlyArray<{ readonly urls: string }>;
}): Promise<HostWindowWebRtcAnswer> {
  const { target, offerSdp } = params;
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const pc = new RTCPeerConnection({
    codecs: {
      video: makeH264Codecs(),
    },
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime(), useTransportWideCC()],
    },
    iceServers: params.iceServers
      ? [...params.iceServers]
      : [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const videoTrack = new MediaStreamTrack({ kind: "video" });
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });

  const existingVideoTransceiver = pc.getTransceivers().find((tr) => tr.kind === "video");
  let sender;
  if (existingVideoTransceiver) {
    existingVideoTransceiver.direction = "sendonly";
    await existingVideoTransceiver.sender.replaceTrack(videoTrack);
    sender = existingVideoTransceiver.sender;
  } else {
    const transceiver = pc.addTransceiver(videoTrack, { direction: "sendonly" });
    sender = transceiver.sender;
  }

  let closed = false;
  const abortController = new AbortController();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeSessions.delete(sessionId);
    abortController.abort();
    videoTrack.stop();
    void pc.close().catch(() => {});
  };

  activeSessions.set(sessionId, { close: cleanup });

  // RTCP PLI / FIR -> trigger immediate hardware IDR keyframe in VideoToolbox helper.
  let lastPliMs = 0;
  sender.onKeyFrameRequest.subscribe(() => {
    const now = Date.now();
    if (closed || now - lastPliMs < KEYFRAME_PLI_COOLDOWN_MS) return;
    lastPliMs = now;
    void postHelperControl(target, "/keyframe");
  });

  // GCC / TWCC / REMB send-side bandwidth estimation -> dynamically adapt helper encoder bitrate.
  let lastBweUpdateMs = 0;
  let lastAppliedBps = 0;
  sender.onAvailableBitrate.subscribe((estimatedBps) => {
    const now = Date.now();
    if (closed || !Number.isFinite(estimatedBps) || estimatedBps <= 0) return;
    if (now - lastBweUpdateMs < BITRATE_UPDATE_COOLDOWN_MS) return;
    const clamped = Math.round(Math.max(800_000, Math.min(14_000_000, estimatedBps * 0.85)));
    if (lastAppliedBps > 0 && Math.abs(clamped - lastAppliedBps) / lastAppliedBps < 0.15) {
      return;
    }
    lastBweUpdateMs = now;
    lastAppliedBps = clamped;
    void postHelperControl(target, "/bitrate", { bps: clamped });
  });

  pc.connectionStateChange.subscribe((state) => {
    if (state === "closed" || state === "failed" || state === "disconnected") {
      cleanup();
    }
  });
  pc.iceConnectionStateChange.subscribe((state) => {
    if (state === "closed" || state === "failed") {
      cleanup();
    }
  });

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    cleanup();
    throw new Error("WebRTC answer SDP was not generated.");
  }

  // Start pumping H.264 AVCC frames from the loopback helper into RFC 6184 RTP over UDP SRTP.
  void (async () => {
    let packetizer: H264Packetizer | null = null;
    let payloadType = 96;
    let sequenceNumber = Math.floor(Math.random() * 0x7fff);
    const startMs = Date.now();

    const ensureConnectedAndPump = async () => {
      try {
        const res = await fetch(`${target.helperOrigin}${target.targetPath}/stream.avcc`, {
          headers: { authorization: `Bearer ${target.helperToken}` },
          signal: abortController.signal,
        });
        if (!res.ok || !res.body) {
          cleanup();
          return;
        }
        const reader = res.body.getReader();
        const framer = new FramedAvccReader();

        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          if (!value) continue;

          for (const frame of framer.push(value)) {
            if (closed) break;
            if (frame.tag === AVCC_TAG_END) {
              cleanup();
              return;
            }
            if (frame.tag === AVCC_TAG_DESCRIPTION) {
              try {
                const record = parseAvcDecoderConfigurationRecord(frame.payload);
                payloadType = sender.codec?.payloadType ?? 96;
                packetizer = new H264Packetizer({
                  naluLengthSize: record.naluLengthSize,
                  inputFormat: "length-prefixed",
                  parameterSets: record.parameterSets,
                  payloadType,
                  ssrc: sender.ssrc,
                  sequenceNumber,
                });
              } catch {}
              continue;
            }
            if (
              (frame.tag === AVCC_TAG_KEYFRAME || frame.tag === AVCC_TAG_DELTA) &&
              packetizer &&
              pc.connectionState !== "closed"
            ) {
              const isKeyframe = frame.tag === AVCC_TAG_KEYFRAME;
              const rtpTimestamp =
                Math.floor(((Date.now() - startMs) * H264_CLOCK_RATE) / 1000) >>> 0;
              const packets = packetizer.packetize(frame.payload, rtpTimestamp, { isKeyframe });
              for (const packet of packets) {
                packet.header.payloadType = sender.codec?.payloadType ?? payloadType;
                packet.header.ssrc = sender.ssrc;
                sequenceNumber = (packet.header.sequenceNumber + 1) & 0xffff;
                try {
                  await sender.sendRtp(packet);
                } catch {}
              }
            }
          }
        }
      } catch {
        // Stream aborted or helper closed
      } finally {
        cleanup();
      }
    };

    // Request a fresh IDR keyframe right as DTLS/ICE becomes connected so playback starts instantly.
    pc.connectionStateChange.subscribe((state) => {
      if (state === "connected" && !closed) {
        void postHelperControl(target, "/keyframe");
      }
    });

    await ensureConnectedAndPump();
  })();

  return {
    type: "answer",
    sdp: localSdp,
    sessionId,
  };
}

export function closeHostWindowWebRtcSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.close();
  return true;
}
