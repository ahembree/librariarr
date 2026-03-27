"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardCardGrid } from "@/components/dashboard-card-grid";
import { AddCardDropdown } from "@/components/add-card-dropdown";
import { SyncIndicator } from "@/components/sync-indicator";
import {
  resolveLayout,
  getDefaultLayout,
  getCardDefinition,
  isCustomCardId,
  CUSTOM_CARD_DEFINITION,
  type CardEntry,
  type DashboardTab,
  type DashboardLayout,
  type CustomCardConfig,
} from "@/lib/dashboard/card-registry";
import { CustomCardDialog } from "@/components/custom-card-dialog";
import { Pencil, Check, Server, Film, Tv, Music, LayoutDashboard } from "lucide-react";
import { cn, generateId } from "@/lib/utils";
import { DashboardSkeleton } from "@/components/skeletons";
import { useRealtime } from "@/hooks/use-realtime";

interface Stats {
  movieCount: number;
  seriesCount: number;
  seasonCount: number;
  musicCount: number;
  artistCount: number;
  albumCount: number;
  episodeCount: number;
  totalSize: string;
  movieSize: string;
  seriesSize: string;
  musicSize: string;
  movieDuration: number;
  seriesDuration: number;
  musicDuration: number;
  qualityBreakdown: {
    resolution: string | null;
    type: string;
    _count: number;
  }[];
  topMovies: {
    id: string;
    title: string;
    year: number | null;
    playCount: number;
  }[];
  topSeries: {
    parentTitle: string;
    totalPlays: number;
    mediaItemId: string | null;
  }[];
  topMusic: {
    parentTitle: string;
    totalPlays: number;
    mediaItemId: string | null;
  }[];
  videoCodecBreakdown: {
    videoCodec: string | null;
    type: string;
    _count: number;
  }[];
  audioCodecBreakdown: {
    audioCodec: string | null;
    type: string;
    _count: number;
  }[];
  contentRatingBreakdown: {
    contentRating: string | null;
    type: string;
    _count: number;
  }[];
  dynamicRangeBreakdown: {
    dynamicRange: string | null;
    type: string;
    _count: number;
  }[];
  audioChannelsBreakdown: {
    audioChannels: number | null;
    type: string;
    _count: number;
  }[];
  genreBreakdown: {
    value: string | null;
    type: string;
    _count: number;
  }[];
}

const VALID_DASHBOARD_TABS = new Set<string>(["main", "movies", "series", "music"]);

function getInitialDashboardTab(): DashboardTab {
  if (typeof window === "undefined") return "main";
  const hash = window.location.hash.slice(1);
  return VALID_DASHBOARD_TABS.has(hash) ? (hash as DashboardTab) : "main";
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>(getInitialDashboardTab);
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("all");
  const [selectedMediaType, setSelectedMediaType] = useState<string>("all");
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [editingCustomCard, setEditingCustomCard] = useState<{ cardId: string; config: CustomCardConfig } | null>(null);

  // Sync active tab to URL hash (replaceState avoids creating extra history
  // entries that break browser back/forward navigation in the App Router)
  useEffect(() => {
    const newHash = `#${activeTab}`;
    if (window.location.hash !== newHash) {
      window.history.replaceState(window.history.state, "", newHash);
    }
  }, [activeTab]);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, layoutRes, serversRes, typesRes] = await Promise.all([
        fetch("/api/media/stats"),
        fetch("/api/settings/dashboard-layout"),
        fetch("/api/servers"),
        fetch("/api/media/library-types"),
      ]);
      const statsData = await statsRes.json();
      setStats(statsData);

      if (layoutRes.ok) {
        const layoutData = await layoutRes.json();
        setLayout(layoutData.layout);
      }

      if (serversRes.ok) {
        const serversData = await serversRes.json();
        setServers(
          (serversData.servers ?? []).map((s: { id: string; name: string }) => ({
            id: s.id,
            name: s.name,
          }))
        );
      }

      if (typesRes.ok) {
        const typesData = await typesRes.json();
        setAvailableTypes(typesData.types ?? []);
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      const url = `/api/media/stats${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      setStats(data);
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    }
  }, [selectedServerId]);

  useRealtime("sync:completed", fetchStats);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Re-fetch stats when server filter changes (skip initial load)
  useEffect(() => {
    if (loading) return;
    fetchStats();
  }, [selectedServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedLayout = resolveLayout(layout) ?? getDefaultLayout();

  const updateLayout = useCallback(
    (tab: DashboardTab, newCards: CardEntry[]) => {
      const newLayout = {
        ...resolvedLayout,
        [tab]: newCards,
      };
      setLayout(newLayout);

      // Persist to backend (fire-and-forget)
      fetch("/api/settings/dashboard-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: newLayout }),
      }).catch((error) => {
        console.error("Failed to save dashboard layout:", error);
      });
    },
    [resolvedLayout]
  );

  const handleMovieClick = useCallback((movieId: string) => {
    router.push(`/library/movies/${movieId}`);
  }, [router]);

  const handleSeriesClick = useCallback(
    (_seriesName: string, mediaItemId?: string) => {
      if (mediaItemId) {
        router.push(`/library/series/show/${mediaItemId}`);
      } else {
        router.push(`/library/series`);
      }
    },
    [router]
  );

  const handleArtistClick = useCallback((mediaItemId: string) => {
    router.push(`/library/music/artist/${mediaItemId}`);
  }, [router]);

  const handleAddCustom = useCallback(
    (config: CustomCardConfig) => {
      const id = `custom-${generateId()}`;
      updateLayout(activeTab, [
        ...resolvedLayout[activeTab],
        { id, size: CUSTOM_CARD_DEFINITION.defaultSize, config },
      ]);
    },
    [activeTab, resolvedLayout, updateLayout]
  );

  const handleConfigChange = useCallback(
    (cardId: string, config: CustomCardConfig) => {
      if (isCustomCardId(cardId)) {
        setEditingCustomCard({ cardId, config });
      }
    },
    []
  );

  const handleConfigSave = useCallback(
    (newConfig: CustomCardConfig) => {
      if (!editingCustomCard) return;
      updateLayout(activeTab, resolvedLayout[activeTab].map((c) =>
        c.id === editingCustomCard.cardId ? { ...c, config: newConfig } : c
      ));
      setEditingCustomCard(null);
    },
    [editingCustomCard, activeTab, resolvedLayout, updateLayout]
  );

  if (loading) {
    return <DashboardSkeleton />;
  }

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Failed to load stats.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          <SyncIndicator onSyncComplete={fetchStats} />
          {servers.length > 1 && (
            <Select
              value={selectedServerId}
              onValueChange={setSelectedServerId}
            >
              <SelectTrigger className="h-9 w-full sm:w-50 text-sm">
                <Server className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="All Servers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Servers</SelectItem>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {activeTab === "main" && (availableTypes.length === 0 || availableTypes.length > 1) && (
            <Select
              value={selectedMediaType}
              onValueChange={setSelectedMediaType}
            >
              <SelectTrigger className="h-9 w-full sm:w-36 text-sm">
                {selectedMediaType === "MOVIE" ? (
                  <Film className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : selectedMediaType === "SERIES" ? (
                  <Tv className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : selectedMediaType === "MUSIC" ? (
                  <Music className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : null}
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {(availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
                  <SelectItem value="MOVIE">Movies</SelectItem>
                )}
                {(availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
                  <SelectItem value="SERIES">Series</SelectItem>
                )}
                {(availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
                  <SelectItem value="MUSIC">Music</SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
          {editMode && (
            <AddCardDropdown
              tab={activeTab}
              existingCards={resolvedLayout[activeTab].map((c) => c.id)}
              onAdd={(cardId) => {
                const def = getCardDefinition(cardId);
                updateLayout(activeTab, [
                  ...resolvedLayout[activeTab],
                  { id: cardId, size: def?.defaultSize ?? 12 },
                ]);
              }}
              onAddCustom={handleAddCustom}
            />
          )}
          <Button
            variant="outline"
            onClick={() => setEditMode(!editMode)}
          >
            {editMode ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <Pencil className="mr-2 h-4 w-4" />
            )}
            {editMode ? "Done" : "Edit Layout"}
          </Button>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DashboardTab)}
        className=""
      >
        <nav className="flex items-center gap-1 border-b mb-6 overflow-x-auto">
          <button
            onClick={() => setActiveTab("main")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              activeTab === "main"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            )}
          >
            <LayoutDashboard className="h-4 w-4" />
            Main
          </button>
          {(availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
            <button
              onClick={() => setActiveTab("movies")}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === "movies"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              )}
            >
              <Film className="h-4 w-4" />
              Movies
            </button>
          )}
          {(availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
            <button
              onClick={() => setActiveTab("series")}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === "series"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              )}
            >
              <Tv className="h-4 w-4" />
              Series
            </button>
          )}
          {(availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
            <button
              onClick={() => setActiveTab("music")}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === "music"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              )}
            >
              <Music className="h-4 w-4" />
              Music
            </button>
          )}
        </nav>

        <TabsContent value="main">
          <DashboardCardGrid
            cards={resolvedLayout.main}
            stats={stats}
            editMode={editMode}
            filterType={selectedMediaType !== "all" ? selectedMediaType as "MOVIE" | "SERIES" | "MUSIC" : undefined}
            serverId={selectedServerId !== "all" ? selectedServerId : undefined}
            servers={servers}
            availableTypes={availableTypes}
            onLayoutChange={(cards) => updateLayout("main", cards)}
            onMovieClick={handleMovieClick}
            onSeriesClick={handleSeriesClick}
            onArtistClick={handleArtistClick}
            onSyncComplete={fetchStats}
            onConfigChange={handleConfigChange}
          />
        </TabsContent>

        {(availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
          <TabsContent value="movies">
            <DashboardCardGrid
              cards={resolvedLayout.movies}
              stats={stats}
              editMode={editMode}
              filterType="MOVIE"
              lockedFilterType
              serverId={selectedServerId !== "all" ? selectedServerId : undefined}
              servers={servers}
              availableTypes={availableTypes}
              onLayoutChange={(cards) => updateLayout("movies", cards)}
              onMovieClick={handleMovieClick}
              onSeriesClick={handleSeriesClick}
              onArtistClick={handleArtistClick}
              onSyncComplete={fetchStats}
              onConfigChange={handleConfigChange}
            />
          </TabsContent>
        )}

        {(availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
          <TabsContent value="series">
            <DashboardCardGrid
              cards={resolvedLayout.series}
              stats={stats}
              editMode={editMode}
              filterType="SERIES"
              lockedFilterType
              serverId={selectedServerId !== "all" ? selectedServerId : undefined}
              servers={servers}
              availableTypes={availableTypes}
              onLayoutChange={(cards) => updateLayout("series", cards)}
              onMovieClick={handleMovieClick}
              onSeriesClick={handleSeriesClick}
              onArtistClick={handleArtistClick}
              onSyncComplete={fetchStats}
              onConfigChange={handleConfigChange}
            />
          </TabsContent>
        )}

        {(availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
          <TabsContent value="music">
            <DashboardCardGrid
              cards={resolvedLayout.music}
              stats={stats}
              editMode={editMode}
              filterType="MUSIC"
              lockedFilterType
              serverId={selectedServerId !== "all" ? selectedServerId : undefined}
              servers={servers}
              availableTypes={availableTypes}
              onLayoutChange={(cards) => updateLayout("music", cards)}
              onMovieClick={handleMovieClick}
              onSeriesClick={handleSeriesClick}
              onArtistClick={handleArtistClick}
              onSyncComplete={fetchStats}
              onConfigChange={handleConfigChange}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Edit custom card dialog */}
      <CustomCardDialog
        open={editingCustomCard !== null}
        onOpenChange={(open) => { if (!open) setEditingCustomCard(null); }}
        onConfirm={handleConfigSave}
        initialConfig={editingCustomCard?.config}
      />
    </div>
  );
}
