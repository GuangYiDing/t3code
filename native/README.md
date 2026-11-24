# Native Host Window Stream Helpers

T3 Code's **Host App** feature delegates OS-level screen/window capture, per-app audio capture,
and native input injection to a small loopback-only helper executable per platform.

The server (`apps/server/src/hostWindow/HostWindowService.ts`) discovers the helper by platform:

- **macOS (`darwin`)**: `native/macos-window-stream/build/<arch>/t3-macos-window-stream`
- **Windows (`win32`)**: `native/windows-window-stream/build/<arch>/t3-windows-window-stream.exe` (planned: DXGI Desktop Duplication + MediaFoundation/NVENC)
- **Linux (`linux`)**: `native/linux-window-stream/build/<arch>/t3-linux-window-stream` (planned: PipeWire/XDG Portal + VAAPI/NVENC)
- **Custom override (any OS)**: `T3CODE_HOST_WINDOW_HELPER_PATH=/path/to/helper`

## Helper Protocol Contract

### Startup Handshake

The server spawns the helper with:

```text
<helper> --port 0 --token <random-hex>
```

The helper binds `127.0.0.1` on an ephemeral port and prints a single line to stdout:

```text
READY {"port":54321,"url":"http://127.0.0.1:54321","pid":12345}
```

All endpoints except `/health` require `Authorization: Bearer <token>` (or `?token=<token>`).

### HTTP Endpoints

| Method   | Path                                  | Purpose                                                                                                   |
| :------- | :------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                             | Health check `{ ok, pid }`                                                                                |
| `GET`    | `/windows`                            | Enumerate `{ permissions, windows, displays }`                                                            |
| `POST`   | `/permissions/request`                | Prompt OS permissions (Screen Recording / Accessibility)                                                  |
| `POST`   | `/permissions/open-settings`          | Open OS privacy settings                                                                                  |
| `GET`    | `/(window\|display)/:id/stream.avcc`  | Framed AVCC H.264 stream (`[u32 len][u8 tag][payload]`, tags: 1=avcC, 2=key, 3=delta, 4=seed JPEG, 7=end) |
| `GET`    | `/(window\|display)/:id/stream.mjpeg` | `multipart/x-mixed-replace; boundary=frame` fallback                                                      |
| `GET`    | `/(window\|display)/:id/snapshot.jpg` | Single JPEG frame                                                                                         |
| `POST`   | `/(window\|display)/:id/keyframe`     | Force immediate hardware IDR keyframe (used by WebRTC RTCP PLI/FIR and WebCodecs recovery)                |
| `POST`   | `/(window\|display)/:id/bitrate`      | Dynamically update encoder target bitrate `{ bps }` (used by WebRTC GCC/TWCC/REMB BWE)                    |
| `POST`   | `/(window\|display)/:id/upload`       | Upload raw file bytes (`X-Filename` header) and paste/drop into target window                             |
| `POST`   | `/displays/virtual`                   | Create a virtual display `{ width, height, hiDPI?, name? }`                                               |
| `DELETE` | `/displays/virtual/:id`               | Destroy a virtual display created by this helper                                                          |

### Server-Side WebRTC Signaling (Proxy Layer)

The T3 Code server (`apps/server/src/hostWindow/HostWindowWebRtc.ts`) bridges the loopback `/stream.avcc` feed into native UDP WebRTC (`ICE + DTLS/SRTP + RFC 6184 H.264 RTP + RTCP NACK/PLI/FIR + GCC/TWCC/REMB`):

- `POST /api/host-window/(window|display)/:id/webrtc/offer` — accepts `{ sdp }`, returns `{ type: "answer", sdp, sessionId }`.
- `DELETE /api/host-window/webrtc/:sessionId` — closes an active WebRTC session.

### WebSocket Endpoints

- `WS /(window|display)/:id/input`:
  - **Client → Host**: `mouse`, `wheel`, `key`, `text`, `clipboard`, `focus`, `resize`, `quality` (`speed|balanced|crisp`), `keyframe` (PLI).
  - **Host → Client**: `screen` (dimensions/title), `cursor` (PNG data URL + hotspot), `clipboard` (host-to-client clipboard sync).
- `WS /(window|display)/:id/audio`:
  - **Host → Client**: initial JSON `{ type: "audio-meta", sampleRate, channels, format: "s16le" }` followed by binary little-endian Int16 interleaved PCM frames isolated to the target window's application.
