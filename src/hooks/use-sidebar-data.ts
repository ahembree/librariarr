"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  SlidersHorizontal,
  Sparkles,
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
        { name: "TRaSH Sync", href: "/tools/trash", icon: SlidersHorizontal },
        { name: "AI Analysis", href: "/tools/ai", icon: Sparkles },
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

export interface CurrentUser {
  username: string;
  authMethod: string;
}

export function useSidebarData(initialCollapsed = false) {
  const router = useRouter();
  const [availableTypes, setAvailableTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [allKnownTypes, setAllKnownTypes] = useState<LibraryType[]>(["MOVIE", "SERIES", "MUSIC"]);
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Persisted in a cookie (not localStorage) so the server layout can read
  // it and SSR the correct state — a client-only read here rendered the
  // collapsed sidebar against expanded server HTML and tripped hydration.
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [activeSessionCount, setActiveSessionCount] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    document.cookie = `sidebar-collapsed=${collapsed ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }, [collapsed]);

  const fetchLibraryTypes = useCallback(() => {
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
    fetchLibraryTypes();
  }, [fetchLibraryTypes]);

  // The nav groups are derived from which library types exist. This was a
  // one-shot mount fetch, so adding a server, enabling a library or finishing a
  // first sync never added the group until a full reload.
  useRealtime("server:changed", fetchLibraryTypes);
  useRealtime("sync:completed", fetchLibraryTypes);

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

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.username) setUser({ username: data.username, authMethod: data.authMethod });
      })
      .catch(() => {});
  }, []);

  const previousUnreachableRef = useRef<Map<string, string>>(new Map());

  const fetchSessionCount = useCallback(() => {
    fetch("/api/tools/sessions")
      .then((res) => res.json())
      .then((data: { sessions?: unknown[]; unreachableServers?: { id: string; name: string; type: string }[] }) => {
        if (data.sessions) setActiveSessionCount(data.sessions.length);

        const current = new Map<string, string>(
          (data.unreachableServers ?? []).map((s) => [s.id, s.name]),
        );
        const previous = previousUnreachableRef.current;

        for (const [id, name] of current) {
          if (!previous.has(id)) {
            toast.error(`${name} is unreachable`, {
              id: `server-down-${id}`,
              description: "Check the server's connection in Settings.",
              duration: 8000,
            });
          }
        }
        for (const [id, name] of previous) {
          if (!current.has(id)) {
            toast.success(`${name} is back online`, {
              id: `server-up-${id}`,
            });
          }
        }

        previousUnreachableRef.current = current;
        window.dispatchEvent(
          new CustomEvent("server-health-changed", {
            detail: { unreachable: data.unreachableServers ?? [] },
          }),
        );
      })
      .catch((e) => console.error("Failed to fetch session count", e));
  }, []);

  // Pushed: `session-changed` is bridged from the media-server WebSocket layer
  // (throttled 2s per server), so a stream starting or stopping updates the
  // badge in about half a second.
  useRealtime("session-changed", fetchSessionCount);
  // A server socket dropping changes the unreachable set this same route
  // reports, so recheck on that too.
  useRealtime("server-status", fetchSessionCount);

  useEffect(() => {
    fetchSessionCount();
    // Fallback only, and deliberately slow. This is the most expensive poll in
    // the app: it runs in the sidebar, which is mounted on every page for the
    // life of the tab, and each tick calls getSessions() against every media
    // server — a live outbound HTTP request per server. At 30s that cost was
    // paid ~2,880 times a day per open tab to render a badge. The pushes above
    // are now the primary path; this only covers a dropped SSE stream.
    const interval = setInterval(fetchSessionCount, 300000);
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

  return { navigation, collapsed, setCollapsed, handleLogout, user };
}
