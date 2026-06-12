"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { StatusStrip } from "@/components/dashboard/status-strip";
import { LibraryTiles } from "@/components/dashboard/library-tiles";
import { LifecyclePipeline } from "@/components/dashboard/lifecycle-pipeline";
import { RecentlyAdded } from "@/components/recently-added";
import type { ScheduleInfo } from "@/components/dashboard/types";
import {
  resolveLayout,
  getDefaultLayout,
  getCardDefinition,
  isCustomCardId,
  CUSTOM_CARD_DEFINITION,
  type CardEntry,
  type DashboardLayout,
  type CustomCardConfig,
} from "@/lib/dashboard/card-registry";
import { CustomCardDialog } from "@/components/custom-card-dialog";
import { AlertCircle, Check, Film, Music, Pencil, Server, Tv } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { generateId } from "@/lib/utils";
import { getDuplicateServerNames } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
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

// Cards that became fixed dashboard zones — excluded from the customizable
// Insights grid (and from its add-card dropdown).
const FIXED_ZONE_CARDS = ["stats", "sync-status", "recently-added"];

/** Zone heading: mono eyebrow label + optional right-aligned controls. */
function SectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h2 className="eyebrow">{label}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [scheduleInfo, setScheduleInfo] = useState<ScheduleInfo | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [servers, setServers] = useState<{ id: string; name: string; type: string }[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("all");
  const [selectedMediaType, setSelectedMediaType] = useState<string>("all");
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [editingCustomCard, setEditingCustomCard] = useState<{ cardId: string; config: CustomCardConfig } | null>(null);
  const [userName, setUserName] = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.username) setUserName(data.username); })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, layoutRes, serversRes, typesRes, scheduleRes] = await Promise.all([
        fetch("/api/media/stats"),
        fetch("/api/settings/dashboard-layout"),
        fetch("/api/servers"),
        fetch("/api/media/library-types"),
        fetch("/api/settings/schedule-info"),
      ]);
      // An error body ({error}) is truthy — setting it as stats would crash
      // the tiles. Leave stats null so the retry empty-state renders.
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }

      if (layoutRes.ok) {
        const layoutData = await layoutRes.json();
        setLayout(layoutData.layout);
      }

      if (serversRes.ok) {
        const serversData = await serversRes.json();
        setServers(
          (serversData.servers ?? []).map((s: { id: string; name: string; type: string }) => ({
            id: s.id,
            name: s.name,
            type: s.type,
          }))
        );
      }

      if (typesRes.ok) {
        const typesData = await typesRes.json();
        setAvailableTypes(typesData.types ?? []);
      }

      if (scheduleRes.ok) {
        setScheduleInfo(await scheduleRes.json());
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Monotonic token guards against out-of-order responses when the server
  // filter flips quickly (a stale slow response must not win).
  const statsReqToken = useRef(0);

  const fetchStats = useCallback(async () => {
    const token = ++statsReqToken.current;
    try {
      const params = new URLSearchParams();
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      const url = `/api/media/stats${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url);
      if (!res.ok || token !== statsReqToken.current) return;
      const data = await res.json();
      if (token !== statsReqToken.current) return;
      setStats(data);
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    }
  }, [selectedServerId]);

  useRealtime("sync:completed", fetchStats);

  useEffect(() => {
    void (async () => { await fetchData(); })();
  }, [fetchData]);

  // Re-fetch stats when server filter changes (skip initial load)
  useEffect(() => {
    if (loading) return;
    void (async () => { await fetchStats(); })();
  }, [selectedServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedLayout = resolveLayout(layout) ?? getDefaultLayout();
  // The Insights grid is the customizable remainder of the old "main" tab
  // layout; cards that became fixed zones above it are filtered out.
  const insightCards = resolvedLayout.main.filter((c) => !FIXED_ZONE_CARDS.includes(c.id));

  const updateInsights = useCallback(
    (newCards: CardEntry[]) => {
      const newLayout = {
        ...resolvedLayout,
        main: newCards,
      };
      setLayout(newLayout);

      // Persist to backend; a rejected save (e.g. layout-size cap) would
      // otherwise look applied and silently evaporate on reload.
      fetch("/api/settings/dashboard-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: newLayout }),
      })
        .then((res) => {
          if (!res.ok) toast.error("Failed to save dashboard layout");
        })
        .catch(() => {
          toast.error("Failed to save dashboard layout");
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

  const handleEpisodeClick = useCallback((episodeId: string) => {
    router.push(`/library/series/episode/${episodeId}`);
  }, [router]);

  const handleTrackClick = useCallback((trackId: string) => {
    router.push(`/library/music/track/${trackId}`);
  }, [router]);

  const handleAddCustom = useCallback(
    (config: CustomCardConfig) => {
      const id = `custom-${generateId()}`;
      updateInsights([
        ...insightCards,
        { id, size: CUSTOM_CARD_DEFINITION.defaultSize, config },
      ]);
    },
    [insightCards, updateInsights]
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
      updateInsights(insightCards.map((c) =>
        c.id === editingCustomCard.cardId ? { ...c, config: newConfig } : c
      ));
      setEditingCustomCard(null);
    },
    [editingCustomCard, insightCards, updateInsights]
  );

  if (loading) {
    return <DashboardSkeleton />;
  }

  if (!stats) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={AlertCircle}
          title="Failed to load dashboard"
          description="We couldn't fetch your library statistics. Check the server connection or try again."
          action={
            <Button variant="outline" size="sm" onClick={() => { setLoading(true); fetchData(); }}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const serverId = selectedServerId !== "all" ? selectedServerId : undefined;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      {/* ── Header ── */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="eyebrow">
            {(() => {
              const now = new Date();
              const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
              const md = now.toLocaleDateString(undefined, { month: "long", day: "numeric" });
              const serverPart = servers.length
                ? ` · ${servers.length} server${servers.length > 1 ? "s" : ""}`
                : "";
              return `${weekday} · ${md}${serverPart}`;
            })()}
          </p>
          <h1 className="mt-1.5 text-2xl sm:text-3xl font-bold font-display tracking-tight">
            {(() => {
              const hour = new Date().getHours();
              const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
              return (
                <>
                  {greeting}
                  {userName && (
                    <>
                      , <span className="text-brand-bright">{userName}</span>
                    </>
                  )}
                </>
              );
            })()}
          </h1>
          <p className="text-muted-foreground mt-1">
            Your library, lifecycle pipeline, and activity at a glance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <SyncIndicator onSyncComplete={fetchStats} />
          {servers.length > 1 && (() => {
            const dupeNames = getDuplicateServerNames(servers);
            return (
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
                      <span className="inline-flex items-center gap-1.5">
                        {server.name}
                        {dupeNames.has(server.name) && (
                          <ServerTypeChip type={server.type} />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })()}
        </div>
      </div>

      <div className="space-y-8">
        {/* ── Zone 1: operational status ── */}
        <StatusStrip scheduleInfo={scheduleInfo} />

        {/* ── Zone 2: library overview ── */}
        <section>
          <SectionHeader label="Library" />
          <LibraryTiles stats={stats} availableTypes={availableTypes} serverId={serverId} />
        </section>

        {/* ── Zone 3: lifecycle pipeline ── */}
        <section>
          <SectionHeader label="Lifecycle pipeline" />
          <LifecyclePipeline scheduleInfo={scheduleInfo} />
        </section>

        {/* ── Zone 4: recently added (component carries its own card title) ── */}
        <section>
          <RecentlyAdded
            serverId={serverId}
            servers={servers}
            availableTypes={availableTypes}
            onMovieClick={handleMovieClick}
            onEpisodeClick={handleEpisodeClick}
            onTrackClick={handleTrackClick}
          />
        </section>

        {/* ── Zone 5: customizable insights ── */}
        <section>
          <SectionHeader label="Insights">
            {(availableTypes.length === 0 || availableTypes.length > 1) && (
              <Select
                value={selectedMediaType}
                onValueChange={setSelectedMediaType}
              >
                <SelectTrigger className="h-8 w-36 text-sm">
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
                tab="main"
                existingCards={[...insightCards.map((c) => c.id), ...FIXED_ZONE_CARDS]}
                onAdd={(cardId) => {
                  const def = getCardDefinition(cardId);
                  updateInsights([
                    ...insightCards,
                    { id: cardId, size: def?.defaultSize ?? 12 },
                  ]);
                }}
                onAddCustom={handleAddCustom}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditMode(!editMode)}
            >
              {editMode ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Pencil className="mr-2 h-4 w-4" />
              )}
              {editMode ? "Done" : "Customize"}
            </Button>
          </SectionHeader>
          <DashboardCardGrid
            cards={insightCards}
            stats={stats}
            editMode={editMode}
            filterType={selectedMediaType !== "all" ? selectedMediaType as "MOVIE" | "SERIES" | "MUSIC" : undefined}
            serverId={serverId}
            servers={servers}
            availableTypes={availableTypes}
            onLayoutChange={updateInsights}
            onMovieClick={handleMovieClick}
            onSeriesClick={handleSeriesClick}
            onArtistClick={handleArtistClick}
            onEpisodeClick={handleEpisodeClick}
            onTrackClick={handleTrackClick}
            onSyncComplete={fetchStats}
            onConfigChange={handleConfigChange}
          />
        </section>
      </div>

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
