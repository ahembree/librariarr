"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Menu, AlertTriangle } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { BackToTop } from "@/components/back-to-top";
import { findScrollContainer } from "@/lib/scroll-utils";
import { useScrollToTop } from "@/hooks/use-scroll-to-top";
import { useRealtime } from "@/hooks/use-realtime";
import { WifiOff } from "lucide-react";

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
  const [maintenanceActive, setMaintenanceActive] = useState(false);
  const [unreachableServers, setUnreachableServers] = useState<UnreachableServer[]>([]);
  useScrollToTop();

  const checkMaintenance = useCallback(() => {
    fetch("/api/tools/maintenance")
      .then((res) => res.json())
      .then((data) => setMaintenanceActive(data.enabled === true))
      .catch((e) => console.error("Failed to check maintenance status", e));
  }, []);

  // Push-driven: `/api/tools/maintenance` emits `settings:changed` on an actual
  // toggle, and the enforcer emits it when it flips maintenance itself. This
  // subscription is also what keeps the shared EventSource alive — it lives in
  // the shell, which never unmounts, so refCount never hits zero on a
  // navigation and the connection is no longer torn down and rebuilt on every
  // route change.
  const { connected: realtimeConnected, authExpired } = useRealtime("settings:changed", checkMaintenance);

  // A media server's socket dropping or recovering now arrives as a push
  // (bridged from realtimeBus); previously this banner waited on the sidebar's
  // 30s session poll failing.
  useRealtime("server-status", () => {
    fetch("/api/tools/sessions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setUnreachableServers(data.unreachableServers ?? []);
      })
      .catch(() => {});
  });

  useEffect(() => {
    checkMaintenance();
    // Fallback only. SSE dies to proxy buffering and idle timeouts, so this
    // stays as a safety net — but at 5 minutes rather than 30 seconds, because
    // the push above is now the primary path.
    const interval = setInterval(checkMaintenance, 300000);

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
      clearInterval(interval);
      window.removeEventListener("maintenance-changed", onMaintenanceChanged);
      window.removeEventListener("server-health-changed", onServerHealthChanged);
    };
  }, [checkMaintenance]);

  return (
    <div className="flex h-screen overflow-hidden">
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
    </div>
  );
}
