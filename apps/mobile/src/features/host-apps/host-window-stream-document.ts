import hostWindowStreamScript from "@t3tools/mobile-host-window-stream";
import type { MobileHostWindowConfig } from "./host-window-stream.browser";

export function hostWindowStreamDocument(config: MobileHostWindowConfig): string {
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  #stage { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; touch-action: none; container-type: size; }
  #wrap { position: relative; width: 100%; height: 100%; transform-origin: center center; }
  #video, #canvas, #mjpeg { width: 100%; height: 100%; object-fit: contain; display: none; user-select: none; }
  #cursor { position: absolute; z-index: 10; pointer-events: none; transform-origin: 0 0; }
  #cursor-img { display: block; max-width: none; }
</style>
</head>
<body>
  <div id="stage">
    <div id="wrap">
      <video id="video" autoplay playsinline muted></video>
      <canvas id="canvas"></canvas>
      <img id="mjpeg" alt="" draggable="false" />
      <div id="cursor"><img id="cursor-img" alt="" /></div>
    </div>
  </div>
  <script>${hostWindowStreamScript}</script>
  <script>window.__t3HostWindowStart && window.__t3HostWindowStart(${serialized});</script>
</body>
</html>`;
}
