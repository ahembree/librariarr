"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LogOut,
  PanelLeftClose,
  PanelLeft,
  AlertTriangle,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSidebarData, type NavItem, type CurrentUser } from "@/hooks/use-sidebar-data";
import { Logo } from "@/components/logo";
import { SearchPalette } from "@/components/search-palette";

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
      {/* Glowing accent bar on the active item's left edge */}
      {isActive && !isCollapsed && (
        <span className="pointer-events-none absolute top-1/2 -left-3.5 h-[18px] w-[3px] -translate-y-1/2 rounded-r-[3px] bg-brand-bright shadow-[0_0_12px_var(--brand)]" />
      )}
      <Icon
        className={cn(
          "h-[17px] w-[17px] shrink-0 transition-colors",
          isActive && "text-brand-bright"
        )}
      />
      {!isCollapsed && (
        <>
          <span className="flex-1 truncate">{item.name}</span>
          {item.warning && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber" />
              </TooltipTrigger>
              <TooltipContent side="right">
                Sync disabled — existing data still searchable
              </TooltipContent>
            </Tooltip>
          )}
          {!!item.badge && item.badge > 0 && (
            <span
              className={cn(
                "flex h-[19px] min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[10.5px] font-semibold tabular-nums",
                isActive
                  ? "bg-white/15 text-foreground"
                  : "bg-brand-dim text-brand-bright"
              )}
            >
              {item.badge}
            </span>
          )}
          {item.dot && (
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full bg-green shadow-[0_0_8px_var(--green)]"
              title={item.dotTooltip ?? "Update available"}
            />
          )}
        </>
      )}
      {isCollapsed && item.warning && (
        <AlertTriangle className="absolute -top-0.5 -right-0.5 h-3 w-3 text-amber" />
      )}
      {isCollapsed && !!item.badge && item.badge > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-mono text-[10px] font-bold text-on-brand">
          {item.badge}
        </span>
      )}
      {isCollapsed && item.dot && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-green" />
      )}
    </>
  );

  const link = (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center rounded-[9px] text-[13.5px] font-medium transition-[color,background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        isCollapsed ? "h-[38px] w-[38px] justify-center" : "h-[38px] gap-[11px] px-[11px]",
        isMobile && "min-h-11",
        isActive
          ? "bg-brand-dim text-foreground"
          : "text-muted-foreground hover:translate-x-px hover:bg-surface-2 hover:text-foreground"
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

function UserChip({
  user,
  isCollapsed,
  onLogout,
  withTooltip = true,
}: {
  user: CurrentUser | null;
  isCollapsed: boolean;
  onLogout: () => void;
  /** The hover tooltip is for the desktop rail; in the mobile drawer the
   *  sheet's focus handling would open it persistently on touch. */
  withTooltip?: boolean;
}) {
  const initial = (user?.username?.trim()?.[0] ?? "A").toUpperCase();
  const avatar = (
    <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-[linear-gradient(135deg,var(--brand-bright),var(--brand))] font-display text-[13px] font-semibold text-on-brand">
      {initial}
    </span>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/settings#authentication"
            className="flex justify-center rounded-[9px] py-1.5 transition-colors hover:bg-surface-2"
          >
            {avatar}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {user?.username ?? "Account"}
          {user?.authMethod ? ` — Admin · ${user.authMethod}` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-[9px] py-1.5 pr-1 pl-2 transition-colors hover:bg-surface-2">
      <Link href="/settings#authentication" className="flex min-w-0 flex-1 items-center gap-2.5">
        {avatar}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold">{user?.username ?? "Admin"}</span>
          <span className="truncate text-[11px] text-faint">
            Admin · {user?.authMethod ?? "Plex"}
          </span>
        </span>
      </Link>
      {(() => {
        const logoutButton = (
          <button
            onClick={onLogout}
            aria-label="Logout"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
          >
            <LogOut className="h-[15px] w-[15px]" />
          </button>
        );
        if (!withTooltip) return logoutButton;
        return (
          <Tooltip>
            <TooltipTrigger asChild>{logoutButton}</TooltipTrigger>
            <TooltipContent side="top">Logout</TooltipContent>
          </Tooltip>
        );
      })()}
    </div>
  );
}

interface SidebarProps {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

export function Sidebar({ mobileOpen, onMobileOpenChange }: SidebarProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { navigation, collapsed, setCollapsed, handleLogout, user } = useSidebarData();
  const [searchOpen, setSearchOpen] = useState(false);

  // Auto-close mobile drawer on navigation
  useEffect(() => {
    if (isMobile) onMobileOpenChange(false);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K / Ctrl+K opens the global title search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sidebarInner = (forceExpanded: boolean) => {
    const isCollapsed = forceExpanded ? false : collapsed;

    return (
      <>
        {/* Faint accent gradient washing the top of the rail */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[120px] bg-linear-to-b from-brand-faint to-transparent" />

        {/* Brand header */}
        <div
          className={cn(
            "flex h-16 shrink-0 items-center gap-[11px]",
            isCollapsed ? "justify-center px-2" : "px-5"
          )}
        >
          <Logo size={30} className="text-brand-bright" />
          {!isCollapsed && (
            <span className="font-display text-[19px] font-semibold tracking-[-0.02em]">
              Librari<span className="text-brand-bright">arr</span>
            </span>
          )}
        </div>

        {/* Search affordance → global title search palette */}
        <button
          type="button"
          onClick={() => {
            if (forceExpanded) onMobileOpenChange(false);
            setSearchOpen(true);
          }}
          className={cn(
            "mx-3.5 mt-1 mb-2 flex h-9 items-center gap-2 rounded-[9px] border border-border bg-surface-0 text-[13px] text-muted-foreground transition-colors hover:border-border-strong",
            isCollapsed ? "justify-center px-0" : "px-[11px]"
          )}
        >
          <Search className="h-[15px] w-[15px] shrink-0" />
          {!isCollapsed && (
            <>
              <span className="flex-1 text-left">Search library…</span>
              <kbd className="rounded-[5px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-faint">
                ⌘K
              </kbd>
            </>
          )}
        </button>

        {/* Navigation */}
        <nav className={cn("flex-1 overflow-y-auto px-3.5 pt-1.5 pb-3.5")}>
          {navigation.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? "mt-3.5" : "mt-1"}>
              {!isCollapsed && (
                <p className="mb-1.5 flex h-3.5 items-center px-2.5 font-mono text-[10px] font-medium tracking-[0.16em] text-faint uppercase">
                  {group.label}
                </p>
              )}
              {isCollapsed && groupIndex > 0 && (
                <div className="mx-1.5 my-3 h-px bg-border opacity-60" />
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

        {/* Footer — collapse toggle + user chip */}
        <div className="flex flex-col gap-0.5 border-t px-3.5 py-2.5">
          {!forceExpanded &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="flex min-h-9 w-full items-center justify-center rounded-[9px] p-2 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
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
                className="flex h-[34px] w-full items-center gap-[11px] rounded-[9px] px-[11px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                aria-expanded={!isCollapsed}
                aria-label="Collapse sidebar"
              >
                <PanelLeftClose className="h-4 w-4" />
                <span>Collapse</span>
              </button>
            ))}
          <UserChip user={user} isCollapsed={isCollapsed} onLogout={handleLogout} withTooltip={!forceExpanded} />
        </div>
      </>
    );
  };

  // Mobile: render as a Sheet drawer
  if (isMobile) {
    return (
      <>
        <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
          <SheetContent
            side="left"
            className="w-[min(16rem,85vw)] p-0"
            showCloseButton={false}
            // Opening focused the logout button (a destructive control) and
            // popped its tooltip persistently on touch — keep focus on the
            // hamburger instead; keyboard users can Tab into the drawer.
            onOpenAutoFocus={(e) => e.preventDefault()}
            // The drawer closes in the same tick the search palette opens;
            // returning focus to the hamburger would steal it from the
            // palette's input and dismiss the mobile keyboard.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <TooltipProvider>
              <div className="pt-safe pb-safe relative flex h-full flex-col overflow-hidden bg-sidebar">
                {sidebarInner(true)}
              </div>
            </TooltipProvider>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: render as permanent sidebar
  return (
    <TooltipProvider>
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <div
        className={cn(
          "relative flex h-screen flex-col overflow-hidden border-r bg-sidebar transition-[width] duration-300 ease-out",
          collapsed ? "w-[72px]" : "w-[248px]"
        )}
      >
        {sidebarInner(false)}
      </div>
    </TooltipProvider>
  );
}
