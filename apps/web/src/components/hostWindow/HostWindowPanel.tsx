import type { HostWindowListResult, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  AlertCircle,
  CheckCircle2,
  Monitor,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  type HostWindowTabTarget,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { hostWindowEnvironment, useHostWindowAccess } from "~/state/hostWindow";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";
import { HostWindowStreamView } from "./HostWindowStreamView";

export function HostWindowPanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "host-window" }>;
  readonly visible: boolean;
}) {
  const { environmentId } = props.threadRef;
  const gt = useGT();
  const listWindows = useAtomCommand(hostWindowEnvironment.list, { reportFailure: false });
  const requestPermissions = useAtomCommand(hostWindowEnvironment.requestPermissions, {
    reportFailure: false,
  });
  const access = useHostWindowAccess(environmentId);

  const [catalog, setCatalog] = useState<HostWindowListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(!props.surface.target);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    const result = await listWindows({ environmentId, input: {} });
    setLoading(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    setCatalog(result.value);
  };

  const showPicker = !props.surface.target || picking;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live OS window list from the host environment when the picker becomes visible.
  useEffect(() => {
    if (!props.visible || !showPicker) return;
    let cancelled = false;
    void listWindows({ environmentId, input: {} }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      setError(null);
      setCatalog(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listWindows, props.visible, showPicker]);

  const selectTarget = (target: HostWindowTabTarget) => {
    useRightPanelStore.getState().openHostWindow(props.threadRef, target);
    setPicking(false);
  };

  const handlePermissionAction = async (openSettings: boolean) => {
    await requestPermissions({ environmentId, input: { openSettings } });
    setTimeout(() => {
      void refresh();
    }, 800);
  };

  const query = search.trim().toLowerCase();
  const windows = catalog?.windows ?? [];
  const filteredWindows = query
    ? windows.filter(
        (win) =>
          win.appName.toLowerCase().includes(query) || win.title.toLowerCase().includes(query),
      )
    : windows;

  const activeTarget = !picking ? props.surface.target : undefined;

  if (activeTarget && access) {
    return (
      <PreviewPanelShell mode={props.mode}>
        <HostWindowStreamView
          key={`${activeTarget.kind}:${activeTarget.id}`}
          environmentId={environmentId}
          target={activeTarget}
          access={access}
          visible={props.visible}
          onSwitchWindow={() => setPicking(true)}
        />
      </PreviewPanelShell>
    );
  }

  const permissions = catalog?.permissions;
  const needsPermissions =
    catalog?.supported &&
    catalog.status === "ready" &&
    permissions !== undefined &&
    (!permissions.screenRecording || !permissions.accessibility);

  return (
    <PreviewPanelShell mode={props.mode}>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <Monitor className="size-4 text-muted-foreground" />
            <span className="text-xs font-semibold">
              <T>Host Apps &amp; Windows</T>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {props.surface.target ? (
              <Button size="xs" variant="ghost" onClick={() => setPicking(false)}>
                <T>Back to stream</T>
              </Button>
            ) : null}
            <Button size="xs" variant="outline" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw className={loading ? "mr-1 size-3 animate-spin" : "mr-1 size-3"} />
              <T>Refresh</T>
            </Button>
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {catalog && (!catalog.supported || catalog.status === "failed") ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <ShieldAlert className="size-6 opacity-70" />
            <p className="max-w-sm">{catalog.detail ?? gt("Host app streaming is unavailable.")}</p>
          </div>
        ) : (
          <>
            {needsPermissions ? (
              <div className="flex flex-col gap-2 border-b bg-warning-surface px-3 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs">
                    {permissions.screenRecording ? (
                      <CheckCircle2 className="size-3 text-success" />
                    ) : (
                      <AlertCircle className="size-3 text-warning" />
                    )}
                    <T>Screen Recording</T>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs">
                    {permissions.accessibility ? (
                      <CheckCircle2 className="size-3 text-success" />
                    ) : (
                      <AlertCircle className="size-3 text-warning" />
                    )}
                    <T>Accessibility</T>
                  </span>
                </div>
                <p className="text-muted-foreground">
                  <T>
                    Grant Screen Recording and Accessibility permissions in macOS System Settings to
                    stream and control host applications.
                  </T>
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => void handlePermissionAction(false)}
                  >
                    <T>Request permissions</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void handlePermissionAction(true)}
                  >
                    <Settings className="mr-1 size-3" />
                    <T>Open System Settings</T>
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="shrink-0 border-b px-3 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={gt("Filter apps or window titles (Chrome, Figma, Finder…)")}
                  className="w-full rounded-md border bg-background py-1.5 pr-2.5 pl-8 text-xs outline-none focus:border-ring"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!catalog && !error ? (
                <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-4" />
                  <T>Discovering host windows…</T>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="px-2 pb-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
                      <T>
                        Application Windows (<Var>{filteredWindows.length}</Var>)
                      </T>
                    </div>
                    {filteredWindows.length === 0 ? (
                      <div className="px-2 py-4 text-xs text-muted-foreground">
                        <T>No matching windows found.</T>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {filteredWindows.map((win) => (
                          <button
                            key={win.id}
                            type="button"
                            onClick={() =>
                              selectTarget({
                                kind: "window",
                                id: win.id,
                                appName: win.appName,
                                title: win.title,
                              })
                            }
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                          >
                            {win.iconBase64 ? (
                              <img
                                src={`data:image/png;base64,${win.iconBase64}`}
                                alt=""
                                className="size-5 shrink-0 rounded object-contain"
                              />
                            ) : (
                              <Monitor className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium">{win.title}</div>
                              <div className="truncate text-2xs text-muted-foreground">
                                {win.appName} · {win.width}×{win.height}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {(catalog?.displays.length ?? 0) > 0 ? (
                    <div>
                      <div className="px-2 pb-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
                        <T>
                          Displays &amp; Virtual Screens (<Var>{catalog?.displays.length ?? 0}</Var>
                          )
                        </T>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {catalog?.displays.map((display) => (
                          <button
                            key={display.id}
                            type="button"
                            onClick={() =>
                              selectTarget({
                                kind: "display",
                                id: display.id,
                                appName: display.isMain ? gt("Main Display") : gt("Display"),
                                title: `#${display.id}`,
                              })
                            }
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                          >
                            <Monitor className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium">
                                {display.isMain
                                  ? gt("Main Display")
                                  : gt("Extended / Virtual Display")}{" "}
                                #{display.id}
                              </div>
                              <div className="truncate text-2xs text-muted-foreground">
                                {display.width}×{display.height} @{display.scale}x
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </PreviewPanelShell>
  );
}
