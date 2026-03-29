"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
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
  CirclePlay,
  Clapperboard,
  Search,
  History,
  ShieldOff,
} from "lucide-react";

type LibraryType = "MOVIE" | "SERIES" | "MUSIC";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  warning?: boolean;
  dot?: boolean;
  dotTooltip?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

function buildNavigation(
  availableTypes: LibraryType[],
  allKnownTypes: LibraryType[],
  badges?: { streams?: number; updateAvailable?: boolean; latestVersion?: string | null },
): NavGroup[] {
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
    { name: "Rules", href: "/lifecycle/rules", icon: Recycle },
    { name: "Rule Matches", href: "/lifecycle/matches", icon: Target },
    { name: "Pending Actions", href: "/lifecycle/pending", icon: Clock },
    { name: "Exceptions", href: "/lifecycle/exceptions", icon: ShieldOff },
  ].filter(Boolean) as NavItem[];

  return [
    {
      label: "Overview",
      items: [{ name: "Dashboard", href: "/", icon: LayoutDashboard }],
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
        { name: "Settings", href: "/settings", icon: Settings, dot: badges?.updateAvailable, dotTooltip: badges?.latestVersion ? `Update available: v${badges.latestVersion}` : undefined },
        { name: "Logs", href: "/system/logs", icon: ScrollText },
      ],
    },
  ].filter((group) => group.items.length > 0);
}

export function useSidebarData() {
  const router = useRouter();
  const [availableTypes, setAvailableTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [allKnownTypes, setAllKnownTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [activeSessionCount, setActiveSessionCount] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

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
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/system/update-check")
      .then((res) => res.json())
      .then((data) => {
        if (data.updateAvailable) {
          setUpdateAvailable(true);
          setLatestVersion(data.latestVersion);
        }
      })
      .catch(() => {});
  }, []);

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
    { streams: activeSessionCount, updateAvailable, latestVersion },
  );

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  return { navigation, collapsed, setCollapsed, handleLogout };
}
