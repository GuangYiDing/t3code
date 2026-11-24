import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createHostVirtualDisplay } from "@t3tools/client-runtime/host-window/stream";
import { EnvironmentId, type HostWindowListResult } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { hostWindowEnvironment, useHostWindowAccess } from "../../state/hostWindow";
import { useAtomCommand } from "../../state/use-atom-command";
import { HostWindowStreamWebView, type HostWindowTargetSelection } from "./HostWindowStreamWebView";

type HostWindowRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
}>;

export function HostWindowRouteScreen({ route }: HostWindowRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const gt = useGT();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { access, refresh: refreshAccess } = useHostWindowAccess(environmentId);
  const listWindows = useAtomCommand(hostWindowEnvironment.list, { reportFailure: false });

  const [catalog, setCatalog] = useState<HostWindowListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingDisplay, setCreatingDisplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HostWindowTargetSelection | null>(null);

  const loadCatalog = async () => {
    setLoading(true);
    setError(null);
    const result = await listWindows({ environmentId, input: {} });
    setLoading(false);
    if (result._tag === "Failure") {
      setError(gt("Could not list host applications."));
      return;
    }
    setCatalog(result.value);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches live host OS window catalog when route mounts.
  useEffect(() => {
    let active = true;
    void listWindows({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result._tag === "Failure") {
        setError(gt("Could not list host applications."));
        return;
      }
      setCatalog(result.value);
    });
    return () => {
      active = false;
    };
  }, [environmentId, gt, listWindows]);

  const handleCreateVirtualDisplay = async () => {
    if (!access || creatingDisplay) return;
    setCreatingDisplay(true);
    setError(null);
    const ratio = winWidth > 0 && winHeight > 0 ? winWidth / winHeight : 1.5;
    const targetW = Math.min(1920, Math.max(1024, Math.round(winWidth * 1.5))) & ~1;
    const targetH = Math.min(1440, Math.max(720, Math.round(targetW / ratio))) & ~1;
    const created = await createHostVirtualDisplay(access, {
      width: targetW,
      height: targetH,
      hiDPI: true,
      name: "T3 Mobile Display",
    }).catch(() => null);
    setCreatingDisplay(false);
    if (!created) {
      setError(gt("Could not create virtual display."));
      return;
    }
    setSelected({
      kind: "display",
      id: created.id,
      appName: created.name,
      title: `${created.width}×${created.height}`,
    });
  };

  if (selected && access) {
    return (
      <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1 }}>
        <HostWindowStreamWebView
          target={selected}
          access={access}
          onUnauthorized={refreshAccess}
          onSwitchWindow={() => setSelected(null)}
          onClose={() => navigation.goBack()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1 }}>
      <View className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <AppText className="text-base font-semibold text-foreground">
            {gt("Host Apps & Displays")}
          </AppText>
          <View className="flex-row items-center gap-2">
            <Button
              label={gt("Refresh")}
              tone="secondary"
              disabled={loading}
              onPress={() => void loadCatalog()}
            />
            <Button label={gt("Close")} tone="secondary" onPress={() => navigation.goBack()} />
          </View>
        </View>

        {error ? (
          <View className="border-b border-border px-4 py-2.5">
            <AppText className="text-xs text-destructive">{error}</AppText>
          </View>
        ) : null}

        {loading && !catalog ? (
          <View className="flex-1 items-center justify-center gap-3">
            <AppActivityIndicator colorClassName="accent-icon" />
            <AppText className="text-sm text-foreground-muted">
              {gt("Discovering host windows…")}
            </AppText>
          </View>
        ) : (
          <ScrollView className="flex-1 px-4 py-3" contentContainerStyle={{ gap: 16 }}>
            <View className="gap-1.5">
              <AppText className="text-xs font-semibold uppercase text-foreground-muted">
                {gt("Application Windows")}
              </AppText>
              {(catalog?.windows ?? []).map((win) => (
                <Pressable
                  key={win.id}
                  onPress={() =>
                    setSelected({
                      kind: "window",
                      id: win.id,
                      appName: win.appName,
                      title: win.title,
                    })
                  }
                  className="rounded-lg border border-border bg-surface px-3 py-2.5"
                >
                  <AppText numberOfLines={1} className="text-sm font-medium text-foreground">
                    {win.title || win.appName}
                  </AppText>
                  <AppText numberOfLines={1} className="text-xs text-foreground-muted">
                    {win.appName} · {win.width}×{win.height}
                  </AppText>
                </Pressable>
              ))}
            </View>

            <View className="gap-1.5">
              <View className="flex-row items-center justify-between">
                <AppText className="text-xs font-semibold uppercase text-foreground-muted">
                  {gt("Displays & Virtual Screens")}
                </AppText>
                {access ? (
                  <Button
                    label={creatingDisplay ? gt("Creating…") : gt("New virtual display")}
                    tone="secondary"
                    disabled={creatingDisplay}
                    onPress={() => void handleCreateVirtualDisplay()}
                  />
                ) : null}
              </View>
              {(catalog?.displays ?? []).map((display) => (
                <Pressable
                  key={display.id}
                  onPress={() =>
                    setSelected({
                      kind: "display",
                      id: display.id,
                      appName: display.isMain ? gt("Main Display") : gt("Display"),
                      title: `#${display.id}`,
                    })
                  }
                  className="rounded-lg border border-border bg-surface px-3 py-2.5"
                >
                  <AppText className="text-sm font-medium text-foreground">
                    {display.isMain ? gt("Main Display") : gt("Virtual / Extended Display")} #
                    {display.id}
                  </AppText>
                  <AppText className="text-xs text-foreground-muted">
                    {display.width}×{display.height} @{display.scale}x
                  </AppText>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}
