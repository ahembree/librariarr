"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Menu, AlertTriangle } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { BackToTop } from "@/components/back-to-top";
import { ReauthDialogHost } from "@/components/reauth-dialog-host";
import { WhatsNewDialog } from "@/components/whats-new-dialog";
import { findScrollContainer } from "@/lib/scroll-utils";
import { useScrollToTop } from "@/hooks/use-scroll-to-top";
import { beforeRealtimeEvents, useRealtime } from "@/hooks/use-realtime";
import { useFallbackPoll } from "@/hooks/use-fallback-poll";
import { fetchJsonShared } from "@/lib/shared-fetch";
import { clearLibraryListCache } from "@/lib/media/list-cache";
import { dropMediaDerivedPrefetches } from "@/lib/media/detail-prefetch";
import { useShellSettings } from "@/components/shell-settings-provider";
import { WifiOff } from "lucide-react";

/**
 * The library pages keep the lists they loaded (`list-cache.ts`) and the
 * detail views take hover-prefetched records (`detail-prefetch.ts`). Anything
 * that changes the media drops both, before any page's own refetch for the same
 * event reads them (`beforeRealtimeEvents`), and on a reconnect's resync, which
 * stands for every event missed.
 */
function dropClientMediaCaches(): void {
  clearLibraryListCache();
  dropMediaDerivedPrefetches();
}
// `sync:failed` too: a sync that wrote some libraries before failing settles
// the dataset (the server's caches are dropped) and announces only the failure.
beforeRealtimeEvents(
  ["sync:completed", "sync:failed", "watch-history:updated", "server:changed", "settings:changed"],
  dropClientMediaCaches,
);


interface UnreachableServer {
  id: string;
  name: string;
  type: string;
}

export function AuthenticatedShell({
  children,
  initialSidebarCollapsed = false,
}: {
  children: React.ReactNode;
  initialSidebarCollapsed?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  // The layout read whether maintenance is on, so the banner is in the first
  // paint; only outside the layout's read is it asked for on mount.
  const shell = useShellSettings();
  const [maintenanceActive, setMaintenanceActive] = useState(
    () => shell?.getSnapshot().maintenanceActive ?? false,
  );
  const maintenanceKnown = useRef(shell !== null);
  const [unreachableServers, setUnreachableServers] = useState<UnreachableServer[]>([]);
  useScrollToTop();

  const checkMaintenance = useCallback(() => {
    // Shared with the Stream Manager, which reads it on the same event.
    fetchJsonShared<{ enabled?: boolean }>("/api/tools/maintenance").then((data) => {
      // A failed check keeps the banner as it is.
      if (data) setMaintenanceActive(data.enabled === true);
      else console.error("Failed to check maintenance status");
    });
  }, []);

  // Push-driven: `/api/tools/maintenance` emits `settings:changed` on an actual
  // toggle, and the enforcer emits it when it flips maintenance itself. This
  // subscription is also what keeps the shared EventSource alive — it lives in
  // the shell, which never unmounts, so refCount never hits zero on a
  // navigation and the connection is no longer torn down and rebuilt on every
  // route change. Do not remove it.
  const { connected: realtimeConnected, authExpired } = useRealtime("settings:changed", checkMaintenance);

  // Fallback only. SSE dies to proxy buffering and idle timeouts, so this
  // stays as a safety net — at 5 minutes, and only while pushes are not
  // arriving, because the push above is the primary path.
  useFallbackPoll(checkMaintenance, 300000);

  // The unreachable-server banner follows the sidebar's session check, which
  // re-reads `/api/tools/sessions` on `server-status` (a media server's socket
  // dropping or recovering, bridged from realtimeBus) and announces the answer
  // as `server-health-changed` below. The shell used to fetch the same route on
  // the same event itself — a second request that asks every media server for
  // its sessions.
  useEffect(() => {
    if (!maintenanceKnown.current) checkMaintenance();

    const onMaintenanceChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean }>).detail;
      setMaintenanceActive(detail.enabled);
    };
    window.addEventListener("maintenance-changed", onMaintenanceChanged);

    const onServerHealthChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ unreachable: UnreachableServer[] }>).detail;
      setUnreachableServers(detail.unreachable ?? []);
    };
    window.addEventListener("server-health-changed", onServerHealthChanged);

    return () => {
      window.removeEventListener("maintenance-changed", onMaintenanceChanged);
      window.removeEventListener("server-health-changed", onServerHealthChanged);
    };
  }, [checkMaintenance]);

  return (
    // dvh, not vh (h-screen): a phone browser's 100vh is its height with the
    // toolbars hidden, so while they show, the bottom of every page sat
    // behind them and the whole frame scrolled as a second layer.
    <div className="px-safe flex h-dvh overflow-hidden">
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
        initialCollapsed={initialSidebarCollapsed}
      />
      <div className="flex flex-1 flex-col overflow-hidden border-l border-white/3">
        {isMobile ? (
          <header className="pt-safe shrink-0 border-b border-white/5 glass">
            <div className="flex h-14 items-center px-4">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open navigation menu"
                onClick={() => setMobileOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <button
                className="ml-3 flex flex-1 items-center gap-2"
                onClick={() => {
                  findScrollContainer()?.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                <Logo size={32} />
                <span className="text-lg font-semibold font-display tracking-tight">
                  Librari<span className="text-brand-bright">arr</span>
                </span>
              </button>
            </div>
          </header>
        ) : (
          <Topbar />
        )}
        {unreachableServers.length > 0 && (
          <Link
            href="/settings#servers"
            className="flex shrink-0 items-center justify-center gap-2 bg-destructive/15 border-b border-destructive/30 px-4 py-1.5 text-sm text-destructive hover:bg-destructive/20 transition-colors"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>
              {unreachableServers.length === 1
                ? `${unreachableServers[0].name} is unreachable`
                : `${unreachableServers.length} servers are unreachable`}
            </span>
          </Link>
        )}
        {authExpired ? (
          <Link
            href="/login"
            className="flex shrink-0 items-center justify-center gap-2 bg-amber/15 border-b border-amber/30 px-4 py-1.5 text-sm text-amber hover:bg-amber/20 transition-colors"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Your session expired &mdash; sign in again</span>
          </Link>
        ) : !realtimeConnected ? (
          <div className="flex shrink-0 items-center justify-center gap-2 border-b border-muted-foreground/20 bg-muted/40 px-4 py-1.5 text-sm text-muted-foreground">
            <WifiOff className="h-3.5 w-3.5" />
            <span>Live updates disconnected &mdash; reconnecting</span>
          </div>
        ) : null}
        {maintenanceActive && (
          <Link
            href="/tools/streams"
            className="flex shrink-0 items-center justify-center gap-2 bg-amber/15 border-b border-amber/30 px-4 py-1.5 text-sm text-amber hover:bg-amber/20 transition-colors"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Maintenance mode is active</span>
          </Link>
        )}
        <main className="canvas-atmosphere pb-safe flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-background">{children}</main>
        <BackToTop />
      </div>
      {/* The "Confirm it's you" prompt behind fetchWithReauth. */}
      <ReauthDialogHost />
      {/* Once per upgrade: the release notes since the last version seen. */}
      <WhatsNewDialog />
    </div>
  );
}
