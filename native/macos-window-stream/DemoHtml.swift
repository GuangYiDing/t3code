import Foundation

enum DemoHtml {
  static func render(token: String) -> String {
    let escapedToken = token
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
    return """
    <!doctype html>
    <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      <title>T3 Code · macOS Host App Stream (Phase 1 MVP)</title>
      <style>
        :root {
          --bg: #0c0d10;
          --panel: #14161b;
          --panel-2: #1c1f26;
          --border: #262a34;
          --text: #eceef4;
          --muted: #8b92a6;
          --accent: #3b82f6;
          --ok: #22c55e;
          --warn: #f59e0b;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; overflow: hidden; }
        .app { display: grid; grid-template-columns: 290px 1fr; height: 100%; }
        .sidebar { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
        .sidebar-head { padding: 14px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
        .title-row { display: flex; align-items: center; justify-content: space-between; }
        .title-row h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
        .perms { display: flex; gap: 6px; flex-wrap: wrap; }
        .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; font-size: 11px; background: var(--panel-2); border: 1px solid var(--border); }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
        .dot.ok { background: var(--ok); }
        .search { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); outline: none; font-size: 12px; }
        .search:focus { border-color: var(--accent); }
        .list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
        .section-label { font-size: 11px; color: var(--muted); padding: 8px 8px 4px; text-transform: uppercase; letter-spacing: 0.04em; }
        .item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--text); cursor: pointer; text-align: left; width: 100%; }
        .item:hover { background: var(--panel-2); }
        .item.active { background: rgba(59, 130, 246, 0.16); border-color: rgba(59, 130, 246, 0.5); }
        .item img { width: 22px; height: 22px; border-radius: 5px; flex-shrink: 0; object-fit: contain; }
        .item-meta { min-width: 0; flex: 1; }
        .item-title { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .item-sub { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
        .toolbar { height: 46px; padding: 0 14px; border-bottom: 1px solid var(--border); background: var(--panel); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .toolbar-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .btn { padding: 5px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); cursor: pointer; font-size: 12px; white-space: nowrap; }
        .btn:hover { background: #262b36; }
        .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
        .stats { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); padding: 4px 8px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border); }
        .stage { flex: 1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #07080a; padding: 12px; }
        .stage-hint { color: var(--muted); text-align: center; max-width: 380px; line-height: 1.6; }
        canvas, #mjpegView { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,0.65); outline: none; touch-action: none; user-select: none; }
        #mjpegView { display: none; }
        #imeInput { position: fixed; opacity: 0; pointer-events: none; width: 1px; height: 1px; left: -9999px; }
      </style>
    </head>
    <body>
      <div class="app">
        <aside class="sidebar">
          <div class="sidebar-head">
            <div class="title-row">
              <h1>macOS Host Apps</h1>
              <button class="btn" id="refreshBtn">刷新</button>
            </div>
            <div class="perms" id="permsBar"></div>
            <input class="search" id="searchInput" placeholder="搜索应用或窗口标题 (Chrome, Finder...)" />
          </div>
          <div class="list" id="windowList"></div>
        </aside>
        <main class="main">
          <header class="toolbar">
            <div class="toolbar-group">
              <strong id="activeLabel" style="font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">未选择窗口</strong>
              <span class="stats" id="statsBadge">Idle</span>
            </div>
            <div class="toolbar-group">
              <button class="btn" data-shortcut="focus">置顶聚焦</button>
              <button class="btn" data-shortcut="cmd-l">⌘L 地址栏</button>
              <button class="btn" data-shortcut="cmd-r">⌘R 刷新</button>
              <button class="btn" data-shortcut="cmd-c">⌘C</button>
              <button class="btn" data-shortcut="cmd-v">⌘V 粘贴</button>
              <button class="btn" data-shortcut="esc">Esc</button>
              <button class="btn" id="modeBtn">模式: AVCC H.264</button>
            </div>
          </header>
          <section class="stage" id="stage">
            <div class="stage-hint" id="emptyHint">
              从左侧选择一个 macOS 应用窗口（例如 Chrome、Arc、Safari 或系统软件），即可 60fps 硬件串流并实时操控。
            </div>
            <canvas id="canvas" style="display:none" tabindex="0"></canvas>
            <img id="mjpegView" alt="" draggable="false" />
            <textarea id="imeInput" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          </section>
        </main>
      </div>
      <script>
        const TOKEN = "\(escapedToken)";
        const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
        const AVCC_TAGS = { 1: "description", 2: "keyframe", 3: "delta", 4: "seed", 7: "end" };

        class AvccDemuxer {
          constructor() { this.buf = new Uint8Array(65536); this.len = 0; }
          push(bytes) {
            if (this.len + bytes.length > this.buf.length) {
              let cap = this.buf.length;
              while (cap < this.len + bytes.length) cap *= 2;
              const grown = new Uint8Array(cap);
              grown.set(this.buf.subarray(0, this.len));
              this.buf = grown;
            }
            this.buf.set(bytes, this.len);
            this.len += bytes.length;
            const out = [];
            let off = 0;
            while (this.len - off >= 4) {
              const view = new DataView(this.buf.buffer, this.buf.byteOffset + off, 4);
              const frameLen = view.getUint32(0, false);
              if (this.len - off - 4 < frameLen) break;
              if (frameLen >= 1) {
                const type = AVCC_TAGS[this.buf[off + 4]];
                if (type) out.push({ type, payload: this.buf.slice(off + 5, off + 4 + frameLen) });
              }
              off += 4 + frameLen;
            }
            if (off > 0) {
              this.buf.copyWithin(0, off, this.len);
              this.len -= off;
            }
            return out;
          }
        }

        function avcCodecString(bytes) {
          if (bytes.length < 4) return "avc1.4d002a";
          const hex = (b) => b.toString(16).padStart(2, "0");
          return `avc1.${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}`;
        }

        const canvas = document.getElementById("canvas");
        const ctx = canvas.getContext("2d");
        const mjpegView = document.getElementById("mjpegView");
        const emptyHint = document.getElementById("emptyHint");
        const windowListEl = document.getElementById("windowList");
        const permsBarEl = document.getElementById("permsBar");
        const activeLabelEl = document.getElementById("activeLabel");
        const statsBadgeEl = document.getElementById("statsBadge");
        const searchInput = document.getElementById("searchInput");
        const modeBtn = document.getElementById("modeBtn");
        const imeInput = document.getElementById("imeInput");

        let catalog = { permissions: {}, windows: [], displays: [] };
        let activeTarget = null; // { kind: "window"|"display", id, label }
        let useMjpeg = !("VideoDecoder" in window);
        let streamAbort = null;
        let decoder = null;
        let ws = null;
        let frameCount = 0;
        let bytesCount = 0;
        let lastStatsTs = performance.now();
        let activeRes = "";
        let pointerButtons = 0;
        let lastClick = { ts: 0, x: 0, y: 0, count: 0, btn: "" };

        modeBtn.textContent = useMjpeg ? "模式: MJPEG" : "模式: AVCC H.264";
        modeBtn.onclick = () => {
          useMjpeg = !useMjpeg;
          modeBtn.textContent = useMjpeg ? "模式: MJPEG" : "模式: AVCC H.264";
          if (activeTarget) connectTarget(activeTarget);
        };

        setInterval(() => {
          const now = performance.now();
          const dt = (now - lastStatsTs) / 1000;
          if (!activeTarget || dt <= 0) return;
          const fps = Math.round(frameCount / dt);
          const kbps = Math.round((bytesCount * 8) / dt / 1000);
          statsBadgeEl.textContent = `${activeRes || "..."} · ${fps} fps · ${kbps} kbps`;
          frameCount = 0;
          bytesCount = 0;
          lastStatsTs = now;
        }, 1000);

        async function loadCatalog() {
          const res = await fetch(`/windows${qs}`);
          catalog = await res.json();
          renderPermissions();
          renderList();
        }

        function renderPermissions() {
          const p = catalog.permissions || {};
          permsBarEl.innerHTML = "";
          const mk = (label, ok) => {
            const el = document.createElement("span");
            el.className = "badge";
            el.innerHTML = `<span class="dot ${ok ? "ok" : ""}"></span>${label}`;
            return el;
          };
          permsBarEl.append(mk("屏幕录制", p.screenRecording), mk("辅助功能", p.accessibility));
          if (!p.screenRecording || !p.accessibility) {
            const req = document.createElement("button");
            req.className = "btn primary";
            req.textContent = "请求授权";
            req.onclick = async () => {
              await fetch(`/permissions/request${qs}`, { method: "POST" });
              setTimeout(loadCatalog, 1000);
            };
            const openBtn = document.createElement("button");
            openBtn.className = "btn";
            openBtn.textContent = "打开系统设置";
            openBtn.onclick = async () => {
              await fetch(`/permissions/open-settings${qs}`, { method: "POST" });
            };
            permsBarEl.append(req, openBtn);
            emptyHint.innerHTML =
              "检测到尚未获得 <strong>屏幕录制</strong> 权限。<br/>请点击左侧「请求授权」或「打开系统设置」，在 <em>隐私与安全性 → 录屏与系统录音</em> 中开启当前宿主应用权限，然后点击「刷新」。";
          } else if (!activeTarget) {
            emptyHint.innerHTML =
              "从左侧选择一个 macOS 应用窗口（例如 Chrome、Arc、Safari 或系统软件），即可 60fps 硬件串流并实时操控。";
          }
        }

        function renderList() {
          const q = searchInput.value.trim().toLowerCase();
          windowListEl.innerHTML = "";
          const addSection = (name) => {
            const h = document.createElement("div");
            h.className = "section-label";
            h.textContent = name;
            windowListEl.append(h);
          };

          const wins = (catalog.windows || []).filter(
            (w) => !q || w.appName.toLowerCase().includes(q) || w.title.toLowerCase().includes(q)
          );
          addSection(`应用窗口 (${wins.length})`);
          for (const w of wins) {
            const btn = document.createElement("button");
            btn.className = "item" + (activeTarget?.kind === "window" && activeTarget.id === w.id ? " active" : "");
            const img = w.iconBase64 ? `<img src="data:image/png;base64,${w.iconBase64}" />` : "";
            btn.innerHTML = `${img}<div class="item-meta"><div class="item-title">${escapeHtml(w.title)}</div><div class="item-sub">${escapeHtml(w.appName)} · ${w.width}×${w.height}</div></div>`;
            btn.onclick = () => connectTarget({ kind: "window", id: w.id, label: `${w.appName} — ${w.title}` });
            windowListEl.append(btn);
          }

          const displays = catalog.displays || [];
          if (displays.length > 0) {
            addSection(`显示器 / 虚拟屏 (${displays.length})`);
            for (const d of displays) {
              const btn = document.createElement("button");
              btn.className = "item" + (activeTarget?.kind === "display" && activeTarget.id === d.id ? " active" : "");
              btn.innerHTML = `<div class="item-meta"><div class="item-title">${d.isMain ? "主显示器" : "扩展/虚拟屏"} #${d.id}</div><div class="item-sub">${d.width}×${d.height} @${d.scale}x</div></div>`;
              btn.onclick = () => connectTarget({ kind: "display", id: d.id, label: `Display #${d.id}` });
              windowListEl.append(btn);
            }
          }
        }

        function escapeHtml(s) {
          return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        }

        function stopStream() {
          streamAbort?.abort();
          streamAbort = null;
          try { decoder?.close(); } catch {}
          decoder = null;
          ws?.close();
          ws = null;
          mjpegView.removeAttribute("src");
        }

        function connectTarget(target) {
          stopStream();
          activeTarget = target;
          activeLabelEl.textContent = target.label;
          statsBadgeEl.textContent = "Connecting...";
          emptyHint.style.display = "none";
          renderList();

          const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
          ws = new WebSocket(`${wsProto}//${location.host}/${target.kind}/${target.id}/input${qs}`);
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === "screen") activeRes = `${msg.width}×${msg.height}`;
            } catch {}
          };

          if (useMjpeg) {
            canvas.style.display = "none";
            mjpegView.style.display = "block";
            mjpegView.src = `/${target.kind}/${target.id}/stream.mjpeg${qs}`;
          } else {
            mjpegView.style.display = "none";
            canvas.style.display = "block";
            startAvcc(target);
          }
        }

        async function startAvcc(target) {
          const ac = new AbortController();
          streamAbort = ac;
          const demuxer = new AvccDemuxer();
          let awaitingKey = true;
          let ts = 0;

          const ensureDecoder = (desc) => {
            try { decoder?.close(); } catch {}
            decoder = new VideoDecoder({
              output: (frame) => {
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                  canvas.width = frame.displayWidth;
                  canvas.height = frame.displayHeight;
                  activeRes = `${frame.displayWidth}×${frame.displayHeight}`;
                }
                ctx.drawImage(frame, 0, 0);
                frame.close();
                frameCount++;
              },
              error: (err) => console.error("VideoDecoder error", err),
            });
            decoder.configure({
              codec: avcCodecString(desc),
              description: desc,
              optimizeForLatency: true,
            });
            awaitingKey = true;
          };

          try {
            const res = await fetch(`/${target.kind}/${target.id}/stream.avcc${qs}`, { signal: ac.signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done || ac.signal.aborted) break;
              bytesCount += value.byteLength;
              for (const chunk of demuxer.push(value)) {
                if (chunk.type === "seed" && !decoder) {
                  createImageBitmap(new Blob([chunk.payload], { type: "image/jpeg" })).then((bmp) => {
                    if (!decoder) {
                      canvas.width = bmp.width;
                      canvas.height = bmp.height;
                      ctx.drawImage(bmp, 0, 0);
                    }
                    bmp.close();
                  }).catch(() => {});
                } else if (chunk.type === "description") {
                  ensureDecoder(chunk.payload);
                } else if (chunk.type === "keyframe" || chunk.type === "delta") {
                  if (!decoder || decoder.state !== "configured") continue;
                  const isKey = chunk.type === "keyframe";
                  if (awaitingKey && !isKey) continue;
                  awaitingKey = false;
                  if (decoder.decodeQueueSize > 8) continue;
                  decoder.decode(new EncodedVideoChunk({
                    type: isKey ? "key" : "delta",
                    timestamp: ts,
                    data: chunk.payload,
                  }));
                  ts += 16667;
                }
              }
            }
          } catch (err) {
            if (!ac.signal.aborted) statsBadgeEl.textContent = `Error: ${err.message}`;
          }
        }

        function sendInput(payload) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        }

        function modMask(e) {
          return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
        }

        function btnName(b) {
          return b === 2 ? "right" : b === 1 ? "middle" : "left";
        }

        function normPoint(el, e) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return {
            x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
          };
        }

        function bindSurface(el) {
          el.addEventListener("contextmenu", (e) => e.preventDefault());
          el.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            imeInput.focus({ preventScroll: true });
            el.setPointerCapture(e.pointerId);
            const pt = normPoint(el, e);
            if (!pt) return;
            const btn = btnName(e.button);
            pointerButtons = e.buttons;
            const now = performance.now();
            const count =
              lastClick.btn === btn && now - lastClick.ts < 450 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6
                ? lastClick.count + 1
                : 1;
            lastClick = { ts: now, x: e.clientX, y: e.clientY, count, btn };
            sendInput({ type: "mouse", action: "down", x: pt.x, y: pt.y, button: btn, clickCount: count, modifiers: modMask(e) });
          });
          el.addEventListener("pointermove", (e) => {
            const pt = normPoint(el, e);
            if (!pt) return;
            const btn = (e.buttons & 1) ? "left" : (e.buttons & 2) ? "right" : (e.buttons & 4) ? "middle" : "none";
            sendInput({ type: "mouse", action: "move", x: pt.x, y: pt.y, button: btn, modifiers: modMask(e) });
          });
          const up = (e) => {
            const pt = normPoint(el, e);
            if (!pt) return;
            pointerButtons = e.buttons;
            sendInput({ type: "mouse", action: "up", x: pt.x, y: pt.y, button: btnName(e.button), clickCount: lastClick.count, modifiers: modMask(e) });
          };
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
          el.addEventListener("wheel", (e) => {
            e.preventDefault();
            const pt = normPoint(el, e);
            if (!pt) return;
            sendInput({ type: "wheel", x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modMask(e) });
          }, { passive: false });
        }

        bindSurface(canvas);
        bindSurface(mjpegView);

        let composing = false;
        imeInput.addEventListener("compositionstart", () => { composing = true; });
        imeInput.addEventListener("compositionend", (e) => {
          composing = false;
          if (e.data) sendInput({ type: "text", text: e.data });
          imeInput.value = "";
        });
        imeInput.addEventListener("keydown", (e) => {
          if (composing || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          sendInput({ type: "key", action: "down", key: e.key, code: e.code, modifiers: modMask(e) });
        });
        imeInput.addEventListener("keyup", (e) => {
          if (composing || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          sendInput({ type: "key", action: "up", key: e.key, code: e.code, modifiers: modMask(e) });
        });

        document.querySelectorAll("[data-shortcut]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const sc = btn.dataset.shortcut;
            if (sc === "focus") sendInput({ type: "focus" });
            else if (sc === "cmd-l") {
              sendInput({ type: "key", action: "down", code: "KeyL", modifiers: 4 });
              sendInput({ type: "key", action: "up", code: "KeyL", modifiers: 4 });
            } else if (sc === "cmd-r") {
              sendInput({ type: "key", action: "down", code: "KeyR", modifiers: 4 });
              sendInput({ type: "key", action: "up", code: "KeyR", modifiers: 4 });
            } else if (sc === "cmd-c") {
              sendInput({ type: "key", action: "down", code: "KeyC", modifiers: 4 });
              sendInput({ type: "key", action: "up", code: "KeyC", modifiers: 4 });
            } else if (sc === "cmd-v") {
              try {
                const text = await navigator.clipboard.readText();
                if (text) sendInput({ type: "clipboard", text, paste: true });
                else {
                  sendInput({ type: "key", action: "down", code: "KeyV", modifiers: 4 });
                  sendInput({ type: "key", action: "up", code: "KeyV", modifiers: 4 });
                }
              } catch {
                sendInput({ type: "key", action: "down", code: "KeyV", modifiers: 4 });
                sendInput({ type: "key", action: "up", code: "KeyV", modifiers: 4 });
              }
            } else if (sc === "esc") {
              sendInput({ type: "key", action: "down", code: "Escape", modifiers: 0 });
              sendInput({ type: "key", action: "up", code: "Escape", modifiers: 0 });
            }
          });
        });

        document.getElementById("refreshBtn").onclick = loadCatalog;
        searchInput.oninput = renderList;
        loadCatalog();
      </script>
    </body>
    </html>
    """
  }
}
