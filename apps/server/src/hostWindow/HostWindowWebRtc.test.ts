import { describe, expect, it } from "vite-plus/test";
import { RTCPeerConnection, RTCRtpCodecParameters, useTransportWideCC } from "werift";

import { closeHostWindowWebRtcSession, createHostWindowWebRtcAnswer } from "./HostWindowWebRtc.ts";

describe("HostWindowWebRtc", () => {
  it("negotiates a sendonly H.264 answer SDP with NACK, PLI, REMB, and TWCC feedback", async () => {
    const clientPc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90_000,
            rtcpFeedback: [
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
              { type: "transport-cc" },
            ],
            parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          }),
        ],
      },
      headerExtensions: {
        video: [useTransportWideCC()],
      },
      iceServers: [],
    });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);

    const answer = await createHostWindowWebRtcAnswer({
      target: {
        helperOrigin: "http://127.0.0.1:1",
        helperToken: "test-token",
        targetPath: "/window/1",
      },
      offerSdp: offer.sdp,
      iceServers: [],
    });

    expect(answer.type).toBe("answer");
    expect(answer.sessionId).toBeTruthy();
    expect(answer.sdp).toContain("H264/90000");
    expect(answer.sdp).toContain("a=sendonly");
    expect(answer.sdp).toContain("nack");
    expect(answer.sdp).toContain("nack pli");
    expect(answer.sdp).toContain("goog-remb");
    expect(answer.sdp).toContain("transport-cc");

    await clientPc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    closeHostWindowWebRtcSession(answer.sessionId);
    await clientPc.close();
  });
});
