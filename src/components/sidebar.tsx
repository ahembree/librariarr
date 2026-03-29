"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LogOut,
  PanelLeftClose,
  PanelLeft,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSidebarData, type NavItem } from "@/hooks/use-sidebar-data";
import { Logo } from "@/components/logo";

function NavItemLink({
  item,
  isActive,
  isCollapsed,
  isMobile,
}: {
  item: NavItem;
  isActive: boolean;
  isCollapsed: boolean;
  isMobile: boolean;
}) {
  const Icon = item.icon;

  const linkContent = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {!isCollapsed && (
        <>
          <span className="flex-1">{item.name}</span>
          {item.warning && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="right">
                Sync disabled — existing data still searchable
              </TooltipContent>
            </Tooltip>
          )}
          {!!item.badge && item.badge > 0 && (
            <span className={cn(
              "flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-semibold px-1.5",
              isActive
                ? "bg-sidebar-primary-foreground/20 text-sidebar-accent-foreground"
                : "bg-sidebar-primary/15 text-sidebar-primary"
            )}>
              {item.badge}
            </span>
          )}
          {item.dot && (
            <span
              className="h-2 w-2 rounded-full bg-emerald-400 shrink-0"
              title={item.dotTooltip ?? "Update available"}
            />
          )}
        </>
      )}
      {isCollapsed && item.warning && (
        <AlertTriangle className="absolute -top-0.5 -right-0.5 h-3 w-3 text-amber-400" />
      )}
      {isCollapsed && !!item.badge && item.badge > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-primary text-[10px] font-bold text-sidebar-primary-foreground px-1">
          {item.badge}
        </span>
      )}
      {isCollapsed && item.dot && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400" />
      )}
    </>
  );

  const link = (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center rounded-md text-sm transition-all duration-300 ease-out focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:outline-none",
        isCollapsed ? "justify-center p-2" : "gap-3 px-3 py-2",
        !isCollapsed && "hover:translate-x-0.5",
        isMobile && "min-h-11",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/6%)] border-l-2 border-sidebar-primary"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      {linkContent}
    </Link>
  );

  if (isCollapsed) {
    const tooltipLabel = [
      item.name,
      item.badge ? ` (${item.badge})` : "",
      item.warning ? " — Sync disabled, existing data still searchable" : "",
      item.dot ? ` — ${item.dotTooltip ?? "Update available"}` : "",
    ].join("");

    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

interface SidebarProps {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

export function Sidebar({ mobileOpen, onMobileOpenChange }: SidebarProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { navigation, collapsed, setCollapsed, handleLogout } = useSidebarData();

  // Auto-close mobile drawer on navigation
  useEffect(() => {
    if (isMobile) onMobileOpenChange(false);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const sidebarInner = (forceExpanded: boolean) => {
    const isCollapsed = forceExpanded ? false : collapsed;

    return (
      <>
        {/* Atmospheric gradient overlay */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-linear-to-b from-primary/5 to-transparent" />

        {/* Header — logo only */}
        <div className={cn(
          "flex h-16 items-center border-b",
          isCollapsed ? "justify-center px-2" : "px-6"
        )}>
          <div className="flex items-center gap-2">
            <Logo size={32} />
            {!isCollapsed && <h1 className="text-xl font-semibold tracking-tight font-display">Librariarr</h1>}
          </div>
        </div>

        {/* Navigation */}
        <nav className={cn("flex-1 overflow-y-auto", isCollapsed ? "p-2" : "p-4")}>
          {navigation.map((group, groupIndex) => (
            <div key={group.label}>
              {groupIndex > 0 && <Separator className="my-3 opacity-30" />}
              {!isCollapsed && (
                <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-widest text-sidebar-foreground/60">
                  {group.label}
                </p>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);

                  return (
                    <NavItemLink
                      key={item.name}
                      item={item}
                      isActive={isActive}
                      isCollapsed={isCollapsed}
                      isMobile={forceExpanded && isMobile}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer — collapse toggle + logout */}
        <div className={cn("border-t", isCollapsed ? "p-2" : "p-4")}>
          <div className="space-y-1">
            {!forceExpanded && (
              isCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setCollapsed(!collapsed)}
                      className="flex w-full items-center justify-center rounded-md p-2 min-h-10 min-w-10 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      aria-expanded={!isCollapsed}
                      aria-label="Expand sidebar"
                    >
                      <PanelLeft className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Expand sidebar</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/70 transition-all duration-150 hover:translate-x-0.5 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  aria-expanded={!isCollapsed}
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose className="h-4 w-4" />
                  <span>Collapse</span>
                </button>
              )
            )}
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleLogout}
                    className="flex w-full items-center justify-center rounded-md p-2 min-h-10 min-w-10 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Logout</TooltipContent>
              </Tooltip>
            ) : (
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/70 transition-all duration-150 hover:translate-x-0.5 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            )}
          </div>
        </div>
      </>
    );
  };

  // Mobile: render as a Sheet drawer
  if (isMobile) {
    return (
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-[min(16rem,85vw)] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <TooltipProvider>
            <div className="flex h-full flex-col bg-sidebar">
              {sidebarInner(true)}
            </div>
          </TooltipProvider>
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: render as permanent sidebar
  return (
    <TooltipProvider>
      <div
        className={cn(
          "relative flex h-screen flex-col border-r bg-sidebar transition-all duration-300 ease-in-out",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {sidebarInner(false)}
      </div>
    </TooltipProvider>
  );
}
