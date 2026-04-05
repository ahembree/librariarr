"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/sidebar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Menu, AlertTriangle } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { BackToTop } from "@/components/back-to-top";
import { findScrollContainer } from "@/lib/scroll-utils";
import { useScrollToTop } from "@/hooks/use-scroll-to-top";

export function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const [maintenanceActive, setMaintenanceActive] = useState(false);
  useScrollToTop();

  const checkMaintenance = useCallback(() => {
    fetch("/api/tools/maintenance")
      .then((res) => res.json())
      .then((data) => setMaintenanceActive(data.enabled === true))
      .catch((e) => console.error("Failed to check maintenance status", e));
  }, []);

  useEffect(() => {
    checkMaintenance();
    const interval = setInterval(checkMaintenance, 30000);

    const onMaintenanceChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean }>).detail;
      setMaintenanceActive(detail.enabled);
    };
    window.addEventListener("maintenance-changed", onMaintenanceChanged);

    return () => {
      clearInterval(interval);
      window.removeEventListener("maintenance-changed", onMaintenanceChanged);
    };
  }, [checkMaintenance]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} />
      <div className="flex flex-1 flex-col overflow-hidden border-l border-white/3">
        {isMobile && (
          <header className="flex h-14 shrink-0 items-center border-b border-white/5 glass px-4">
            <Button
              variant="ghost"
              size="icon"
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
              <span className="text-lg font-semibold font-display tracking-tight">Librariarr</span>
            </button>
          </header>
        )}
        {maintenanceActive && (
          <Link
            href="/tools/streams"
            className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 border-b border-amber-500/30 px-4 py-1.5 text-sm text-amber-400 hover:bg-amber-500/20 transition-colors"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Maintenance mode is active</span>
          </Link>
        )}
        <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-background bg-[radial-gradient(ellipse_at_50%_0%,oklch(0.22_0.02_270)_0%,transparent_60%)]">{children}</main>
        <BackToTop />
      </div>
    </div>
  );
}
