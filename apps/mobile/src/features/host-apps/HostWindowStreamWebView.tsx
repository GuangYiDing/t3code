import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type {
  HostWindowActiveTransport,
  HostWindowQualityPreset,
  HostWindowStreamStats,
} from "@t3tools/client-runtime/host-window/stream";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText } from "../../components/ui/AppText";
import { hostWindowStreamDocument } from "./host-window-stream-document";

export interface HostWindowTargetSelection {
  readonly kind: "window" | "display";
  readonly id: number;
  readonly appName: string;
  readonly title: string;
}

const QUALITY_CYCLE: ReadonlyArray<HostWindowQualityPreset> = ["balanced", "crisp", "speed"];

function parseHostWindowMessage(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function HostWindowStreamWebView(props: {
  readonly target: HostWindowTargetSelection;
  readonly access: DeviceHubAccess;
  readonly onUnauthorized: () => void;
  readonly onSwitchWindow: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const webViewRef = useRef<WebView<object>>(null);
  const [touchMode, setTouchMode] = useState<"trackpad" | "direct">("trackpad");
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [quality, setQuality] = useState<HostWindowQualityPreset>("balanced");
  const [transport, setTransport] = useState<HostWindowActiveTransport>("webrtc");
  const [stats, setStats] = useState<HostWindowStreamStats | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");

  const html = hostWindowStreamDocument({
    kind: props.target.kind,
    id: props.target.id,
    access: props.access,
    transport: "auto",
  });

  const sendCommand = (payload: Record<string, unknown>) => {
    const serialized = JSON.stringify(payload);
    webViewRef.current?.injectJavaScript(
      `window.__t3HostWindowCommand && window.__t3HostWindowCommand(${serialized}); true;`,
    );
  };

  const toggleTouchMode = () => {
    const next = touchMode === "trackpad" ? "direct" : "trackpad";
    setTouchMode(next);
    sendCommand({ type: "mode", mode: next });
  };

  const toggleAudio = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    sendCommand({ type: "audio", audio: next });
  };

  const cycleQuality = () => {
    const next =
      QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(quality) + 1) % QUALITY_CYCLE.length] ?? "balanced";
    setQuality(next);
    sendCommand({ type: "quality", preset: next });
  };

  const handlePaste = () => {
    void Clipboard.getStringAsync()
      .then((text) => {
        if (text) sendCommand({ type: "text", text });
      })
      .catch(() => {});
  };

  const transportLabel =
    transport === "webrtc" ? "WebRTC" : transport === "mjpeg" ? "MJPEG" : "H.264";
  const qualityLabel =
    quality === "crisp" ? gt("Crisp") : quality === "speed" ? gt("Speed") : gt("Auto");

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
        <View className="min-w-0 flex-1">
          <AppText numberOfLines={1} className="text-xs font-semibold text-foreground">
            {props.target.appName}
          </AppText>
          <AppText numberOfLines={1} className="text-2xs text-foreground-muted">
            {status === "streaming" && stats
              ? gt("{width}×{height} · {fps} fps · {transport}", {
                  width: stats.width,
                  height: stats.height,
                  fps: stats.fps,
                  transport: transportLabel,
                })
              : status === "error"
                ? gt("Stream unavailable")
                : gt("Connecting…")}
          </AppText>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Pressable onPress={toggleTouchMode} className="rounded-md bg-surface-muted px-2 py-1">
            <AppText className="text-2xs font-medium text-foreground">
              {touchMode === "trackpad" ? gt("Pointer") : gt("Touch")}
            </AppText>
          </Pressable>
          <Pressable onPress={toggleAudio} className="rounded-md bg-surface-muted px-2 py-1">
            <AppText className="text-2xs font-medium text-foreground">
              {audioEnabled ? gt("Mute") : gt("Audio")}
            </AppText>
          </Pressable>
          <Pressable onPress={cycleQuality} className="rounded-md bg-surface-muted px-2 py-1">
            <AppText className="text-2xs font-medium text-foreground">{qualityLabel}</AppText>
          </Pressable>
          {props.target.kind === "window" ? (
            <Pressable
              onPress={() => sendCommand({ type: "fit" })}
              className="rounded-md bg-surface-muted px-2 py-1"
            >
              <AppText className="text-2xs font-medium text-foreground">{gt("Fit")}</AppText>
            </Pressable>
          ) : null}
          <Pressable onPress={handlePaste} className="rounded-md bg-surface-muted px-2 py-1">
            <AppText className="text-2xs font-medium text-foreground">{gt("Paste")}</AppText>
          </Pressable>
          <Pressable
            onPress={props.onSwitchWindow}
            className="rounded-md bg-surface-muted px-2 py-1"
          >
            <AppText className="text-2xs font-medium text-foreground">{gt("Switch")}</AppText>
          </Pressable>
          <Pressable onPress={props.onClose} className="rounded-md bg-surface-muted px-2 py-1">
            <AppText className="text-2xs font-medium text-foreground">{gt("Done")}</AppText>
          </Pressable>
        </View>
      </View>

      <WebView<object>
        ref={webViewRef}
        source={{ html, baseUrl: props.access.httpBase }}
        originWhitelist={["*"]}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={{ flex: 1, backgroundColor: "#000" }}
        onMessage={(event) => {
          const parsed = parseHostWindowMessage(event.nativeEvent.data);
          if (!parsed) return;
          if (parsed.type === "status" && typeof parsed.status === "string") {
            if (
              parsed.status === "connecting" ||
              parsed.status === "streaming" ||
              parsed.status === "error"
            ) {
              setStatus(parsed.status);
            }
          } else if (parsed.type === "stats" && parsed.stats && typeof parsed.stats === "object") {
            setStats(parsed.stats as HostWindowStreamStats);
          } else if (parsed.type === "transport" && typeof parsed.transport === "string") {
            if (
              parsed.transport === "webrtc" ||
              parsed.transport === "avcc" ||
              parsed.transport === "mjpeg"
            ) {
              setTransport(parsed.transport);
            }
          } else if (parsed.type === "clipboard" && typeof parsed.text === "string") {
            void Clipboard.setStringAsync(parsed.text).catch(() => {});
          } else if (parsed.type === "haptic") {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          } else if (parsed.type === "unauthorized") {
            props.onUnauthorized();
          }
        }}
      />
    </View>
  );
}
