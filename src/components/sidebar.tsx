"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Film,
  Tv,
  Music,
  Recycle,
  Clock,
  Target,
  Settings,
  ScrollText,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  CirclePlay,
  Clapperboard,
  AlertTriangle,
  Search,
  History,
  ShieldOff,
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
import { Logo } from "@/components/logo";

type LibraryType = "MOVIE" | "SERIES" | "MUSIC";

interface NavItem {
  name: string;
  href: string;
  icon: typeof Film;
  badge?: number;
  warning?: boolean;
}

function buildNavigation(
  availableTypes: LibraryType[],
  allKnownTypes: LibraryType[],
  badges?: { streams?: number },
) {
  const hasMovies = availableTypes.includes("MOVIE");
  const hasSeries = availableTypes.includes("SERIES");
  const hasMusic = availableTypes.includes("MUSIC");

  const knownMovies = allKnownTypes.includes("MOVIE");
  const knownSeries = allKnownTypes.includes("SERIES");
  const knownMusic = allKnownTypes.includes("MUSIC");

  const libraryItems = [
    (hasMovies || knownMovies) && { name: "Movies", href: "/library/movies", icon: Film, warning: knownMovies && !hasMovies },
    (hasSeries || knownSeries) && { name: "Series", href: "/library/series", icon: Tv, warning: knownSeries && !hasSeries },
    (hasMusic || knownMusic) && { name: "Music", href: "/library/music", icon: Music, warning: knownMusic && !hasMusic },
    { name: "History", href: "/library/history", icon: History },
    { name: "Query", href: "/library/query", icon: Search },
  ].filter(Boolean) as NavItem[];

  const lifecycleItems = [
    (hasMovies || knownMovies) && { name: "Movie Rules", href: "/lifecycle/movies", icon: Recycle, warning: knownMovies && !hasMovies },
    (hasSeries || knownSeries) && { name: "Series Rules", href: "/lifecycle/series", icon: Recycle, warning: knownSeries && !hasSeries },
    (hasMusic || knownMusic) && { name: "Music Rules", href: "/lifecycle/music", icon: Recycle, warning: knownMusic && !hasMusic },
    { name: "Rule Matches", href: "/lifecycle/matches", icon: Target },
    { name: "Pending Actions", href: "/lifecycle/pending", icon: Clock },
    { name: "Exceptions", href: "/lifecycle/exceptions", icon: ShieldOff },
  ].filter(Boolean) as NavItem[];

  return [
    {
      label: "Overview",
      items: [
        { name: "Dashboard", href: "/", icon: LayoutDashboard },
      ],
    },
    {
      label: "Library",
      items: libraryItems,
    },
    {
      label: "Lifecycle",
      items: lifecycleItems,
    },
    {
      label: "Tools",
      items: [
        { name: "Streams", href: "/tools/streams", icon: CirclePlay, badge: badges?.streams },
        { name: "Prerolls", href: "/tools/preroll", icon: Clapperboard },
      ],
    },
    {
      label: "System",
      items: [
        { name: "Settings", href: "/settings", icon: Settings },
        { name: "Logs", href: "/system/logs", icon: ScrollText },
      ],
    },
  ].filter((group) => group.items.length > 0);
}

interface SidebarProps {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

export function Sidebar({ mobileOpen, onMobileOpenChange }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [availableTypes, setAvailableTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [allKnownTypes, setAllKnownTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [activeSessionCount, setActiveSessionCount] = useState(0);

  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    fetch("/api/media/library-types")
      .then((res) => res.json())
      .then((data) => {
        if (data.types && data.types.length > 0) {
          setAvailableTypes(data.types);
        }
        if (data.allTypes && data.allTypes.length > 0) {
          setAllKnownTypes(data.allTypes);
        }
      })
      .catch(() => {
        // On error, show all types
      });
  }, []);

  // Auto-close mobile drawer on navigation
  useEffect(() => {
    if (isMobile) onMobileOpenChange(false);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll active session count
  const fetchSessionCount = useCallback(() => {
    fetch("/api/tools/sessions")
      .then((res) => res.json())
      .then((data) => {
        if (data.sessions) setActiveSessionCount(data.sessions.length);
      })
      .catch((e) => console.error("Failed to fetch session count", e));
  }, []);

  useEffect(() => {
    fetchSessionCount();
    const interval = setInterval(fetchSessionCount, 30000);
    return () => clearInterval(interval);
  }, [fetchSessionCount]);

  const navigation = buildNavigation(
    availableTypes,
    allKnownTypes,
    { streams: activeSessionCount },
  );

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  // Shared sidebar content — forceExpanded=true for the mobile drawer (always expanded)
  const sidebarInner = (forceExpanded: boolean) => {
    const isCollapsed = forceExpanded ? false : collapsed;

    return (
      <>
        <div className={cn(
          "flex h-16 items-center border-b",
          isCollapsed ? "justify-center px-2" : "justify-between px-6"
        )}>
          <div className="flex items-center gap-2">
            <Logo size={24} />
            {!isCollapsed && <h1 className="text-xl font-bold">Librariarr</h1>}
          </div>
          {!forceExpanded && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                  {isCollapsed ? (
                    <PanelLeft className="h-5 w-5" />
                  ) : (
                    <PanelLeftClose className="h-5 w-5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <nav className={cn("flex-1 overflow-y-auto", isCollapsed ? "p-2" : "p-4")}>
          {navigation.map((group, groupIndex) => (
            <div key={group.label}>
              {groupIndex > 0 && <Separator className="my-3" />}
              {!isCollapsed && (
                <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);

                  // Warning item (collapsed) — link still works, shows warning tooltip
                  if (isCollapsed && item.warning) {
                    return (
                      <Tooltip key={item.name}>
                        <TooltipTrigger asChild>
                          <Link
                            href={item.href}
                            className={cn(
                              "relative flex items-center justify-center rounded-lg p-2 transition-colors",
                              isActive
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <Icon className="h-4 w-4" />
                            <AlertTriangle className="absolute -top-0.5 -right-0.5 h-3 w-3 text-amber-400" />
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {item.name} — Sync disabled, existing data still searchable
                        </TooltipContent>
                      </Tooltip>
                    );
                  }

                  // Normal collapsed item
                  if (isCollapsed) {
                    return (
                      <Tooltip key={item.name}>
                        <TooltipTrigger asChild>
                          <Link
                            href={item.href}
                            className={cn(
                              "relative flex items-center justify-center rounded-lg p-2 transition-colors",
                              isActive
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <Icon className="h-4 w-4" />
                            {!!item.badge && item.badge > 0 && (
                              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground px-1">
                                {item.badge}
                              </span>
                            )}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {item.name}{item.badge ? ` (${item.badge})` : ""}
                        </TooltipContent>
                      </Tooltip>
                    );
                  }

                  // Warning item (expanded) — link still works, shows warning icon with tooltip
                  if (item.warning) {
                    return (
                      <Link
                        key={item.name}
                        href={item.href}
                        className={cn(
                          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="flex-1">{item.name}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            Sync disabled — existing data still searchable
                          </TooltipContent>
                        </Tooltip>
                      </Link>
                    );
                  }

                  // Normal expanded item
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="flex-1">{item.name}</span>
                      {!!item.badge && item.badge > 0 && (
                        <span className={cn(
                          "flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-semibold px-1.5",
                          isActive
                            ? "bg-primary-foreground/20 text-primary-foreground"
                            : "bg-primary/15 text-primary"
                        )}>
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className={cn("border-t", isCollapsed ? "p-2" : "p-4")}>
          {isCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Logout</TooltipContent>
            </Tooltip>
          ) : (
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          )}
        </div>
      </>
    );
  };

  // Mobile: render as a Sheet drawer
  if (isMobile) {
    return (
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-64 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <TooltipProvider>
            <div className="flex h-full flex-col bg-card">
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
          "flex h-screen flex-col border-r bg-card transition-all duration-200",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {sidebarInner(false)}
      </div>
    </TooltipProvider>
  );
}
