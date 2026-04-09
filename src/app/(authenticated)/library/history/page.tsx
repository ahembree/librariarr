"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { ServerChips } from "@/components/server-chips";
import { getDuplicateServerNames } from "@/lib/server-styles";
import { ServerTypeChip } from "@/components/server-type-chip";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RefreshCw,
  Loader2,
  Search,
  Columns3,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { useServers } from "@/hooks/use-servers";
import { useChipColors } from "@/components/chip-color-provider";
import { formatFileSize, formatDuration } from "@/lib/format";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { EmptyState } from "@/components/empty-state";
import type { MediaItemWithRelations } from "@/lib/types";

// ── Types ────────────────────────────────────────────────────────

interface WatchHistoryItem {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  mediaItem: {
    id: string;
    title: string;
    titleSort: string | null;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number | null;
    type: string;
    resolution: string | null;
    dynamicRange: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    audioProfile: string | null;
    fileSize: string | null;
    duration: number | null;
    summary: string | null;
    contentRating: string | null;
    rating: number | null;
    ratingImage: string | null;
    audienceRating: number | null;
    audienceRatingImage: string | null;
    studio: string | null;
    playCount: number;
    lastPlayedAt: string | null;
    addedAt: string | null;
    genres: string[] | null;
  };
  server: { id: string; name: string; type: string };
}

// ── Constants ────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const TYPE_BADGE_COLORS: Record<string, string> = {
  MOVIE: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  SERIES: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  MUSIC: "bg-green-500/20 text-green-400 border-green-500/30",
};

const TYPE_LABELS: Record<string, string> = {
  MOVIE: "Movie",
  SERIES: "Series",
  MUSIC: "Music",
};

const COLUMN_TO_SORT_FIELD: Record<string, string> = {
  title: "title",
  type: "type",
  serverUsername: "serverUsername",
  watchedAt: "watchedAt",
  year: "year",
  resolution: "resolution",
  dynamicRange: "dynamicRange",
  duration: "duration",
  fileSize: "fileSize",
  deviceName: "deviceName",
  platform: "platform",
  server: "serverUsername",
};

const VISIBLE_KEY = "history-visible-columns";

function loadVisibleColumns(): Set<string> {
  try {
    const stored = localStorage.getItem(VISIBLE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* use defaults */ }
  return new Set<string>();
}

function saveVisibleColumns(cols: Set<string>) {
  localStorage.setItem(VISIBLE_KEY, JSON.stringify([...cols]));
}

function formatResolution(res: string | null) {
  if (!res) return "";
  const label = normalizeResolutionLabel(res);
  return label === "Other" ? res : label;
}

function formatWatchedAt(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const watchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - watchDay.getTime()) / 86400000);

  if (diffDays === 0) {
    return `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function getItemTitle(item: WatchHistoryItem): string {
  const mi = item.mediaItem;
  if (mi.type === "SERIES" && mi.parentTitle) {
    const ep = mi.seasonNumber != null && mi.episodeNumber != null
      ? ` - S${String(mi.seasonNumber).padStart(2, "0")}E${String(mi.episodeNumber).padStart(2, "0")}`
      : "";
    return `${mi.parentTitle}${ep} - ${mi.title}`;
  }
  if (mi.type === "MUSIC" && mi.parentTitle) {
    return `${mi.parentTitle} - ${mi.title}`;
  }
  return mi.title;
}

function getItemDetailUrl(item: WatchHistoryItem): string {
  switch (item.mediaItem.type) {
    case "MOVIE": return `/library/movies/${item.mediaItem.id}`;
    case "SERIES": return `/library/series/episode/${item.mediaItem.id}`;
    case "MUSIC": return `/library/music/track/${item.mediaItem.id}`;
    default: return `/library/movies/${item.mediaItem.id}`;
  }
}

// ── Column groups ────────────────────────────────────────────────

interface HistoryColumn extends DataTableColumn<WatchHistoryItem> {
  group: string;
  defaultVisible: boolean;
}

const COLUMN_GROUPS: Record<string, string> = {
  core: "Core",
  playback: "Playback",
  video: "Video",
  audio: "Audio",
  file: "File",
  device: "Device",
};

// ── Component ────────────────────────────────────────────────────

export default function HistoryPage() {
  const { servers } = useServers();
  const { getBadgeStyle } = useChipColors();
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "library-history-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });

  // Data
  const [items, setItems] = useState<WatchHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [selectedDetailUrl, setSelectedDetailUrl] = useState<string>("");
  const [, setLoadingDetail] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Sort (server-side)
  const [sortBy, setSortBy] = useState("watchedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Filter dropdowns data
  const [usernames, setUsernames] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);

  // Filters
  const [search, setSearch] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string>("all");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set());
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedResolutions] = useState<Set<string>>(new Set());

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => loadVisibleColumns());

  // ── Column definitions ──────────────────────────────────────────

  const allColumns: HistoryColumn[] = useMemo(() => [
    {
      id: "title",
      header: "Title",
      defaultWidth: 250,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <span className="truncate font-medium" title={getItemTitle(item)}>
          {getItemTitle(item)}
        </span>
      ),
      sortValue: (item) => item.mediaItem.titleSort ?? item.mediaItem.title,
    },
    {
      id: "type",
      header: "Type",
      defaultWidth: 80,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <ColorChip className={cn("text-xs", TYPE_BADGE_COLORS[item.mediaItem.type])}>
          {TYPE_LABELS[item.mediaItem.type] ?? item.mediaItem.type}
        </ColorChip>
      ),
      sortValue: (item) => item.mediaItem.type,
    },
    {
      id: "serverUsername",
      header: "User",
      defaultWidth: 120,
      group: "playback",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.serverUsername,
      sortValue: (item) => item.serverUsername,
    },
    {
      id: "watchedAt",
      header: "Watched At",
      defaultWidth: 140,
      group: "playback",
      defaultVisible: true,
      accessor: (item) => (
        <span className="text-muted-foreground" title={item.watchedAt ?? undefined}>
          {formatWatchedAt(item.watchedAt)}
        </span>
      ),
      sortValue: (item) => item.watchedAt ? new Date(item.watchedAt).getTime() : 0,
    },
    {
      id: "year",
      header: "Year",
      defaultWidth: 70,
      group: "core",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => item.mediaItem.year ?? "-",
      sortValue: (item) => item.mediaItem.year,
    },
    {
      id: "resolution",
      header: "Resolution",
      defaultWidth: 100,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        const res = item.mediaItem.resolution;
        if (!res) return "-";
        const label = formatResolution(res);
        return (
          <ColorChip style={getBadgeStyle("resolution", label)}>
            {label}
          </ColorChip>
        );
      },
      sortValue: (item) => item.mediaItem.resolution,
    },
    {
      id: "dynamicRange",
      header: "HDR",
      defaultWidth: 90,
      group: "video",
      defaultVisible: true,
      accessor: (item) => {
        const dr = item.mediaItem.dynamicRange;
        if (!dr) return "-";
        return (
          <ColorChip style={getBadgeStyle("dynamicRange", dr)}>
            {dr}
          </ColorChip>
        );
      },
      sortValue: (item) => item.mediaItem.dynamicRange,
    },
    {
      id: "videoCodec",
      header: "Video Codec",
      defaultWidth: 100,
      group: "video",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => item.mediaItem.videoCodec ?? "-",
      sortValue: (item) => item.mediaItem.videoCodec,
    },
    {
      id: "duration",
      header: "Duration",
      defaultWidth: 90,
      group: "file",
      defaultVisible: true,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => formatDuration(item.mediaItem.duration),
      sortValue: (item) => item.mediaItem.duration,
    },
    {
      id: "fileSize",
      header: "Size",
      defaultWidth: 90,
      group: "file",
      defaultVisible: false,
      className: "text-right text-muted-foreground",
      headerClassName: "text-right",
      accessor: (item) => formatFileSize(item.mediaItem.fileSize),
      sortValue: (item) => (item.mediaItem.fileSize ? Number(item.mediaItem.fileSize) : null),
    },
    {
      id: "audioCodec",
      header: "Audio",
      defaultWidth: 130,
      group: "audio",
      defaultVisible: false,
      className: "text-muted-foreground",
      accessor: (item) => {
        const codec = item.mediaItem.audioCodec ?? "";
        const ch = item.mediaItem.audioChannels;
        return ch ? `${codec} ${ch}ch` : codec || "-";
      },
      sortValue: (item) => item.mediaItem.audioCodec,
    },
    {
      id: "deviceName",
      header: "Device",
      defaultWidth: 120,
      group: "device",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.deviceName ?? "-",
      sortValue: (item) => item.deviceName,
    },
    {
      id: "platform",
      header: "Platform",
      defaultWidth: 100,
      group: "device",
      defaultVisible: true,
      className: "text-muted-foreground",
      accessor: (item) => item.platform ?? "-",
      sortValue: (item) => item.platform,
    },
    {
      id: "server",
      header: "Server",
      defaultWidth: 110,
      group: "core",
      defaultVisible: true,
      accessor: (item) => (
        <ServerChips servers={[{ serverId: item.server.id, serverName: item.server.name, serverType: item.server.type }]} />
      ),
      sortValue: (item) => item.server.name,
    },
  ], [getBadgeStyle]);

  // ── Column visibility ──────────────────────────────────────────

  const activeColumns = useMemo(() => {
    if (visibleCols.size === 0) {
      return allColumns.filter((c) => c.defaultVisible);
    }
    return allColumns.filter((c) => visibleCols.has(c.id));
  }, [allColumns, visibleCols]);

  const toggleColumn = useCallback((colId: string) => {
    setVisibleCols((prev) => {
      const next = new Set(prev.size === 0
        ? allColumns.filter((c) => c.defaultVisible).map((c) => c.id)
        : prev,
      );
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      saveVisibleColumns(next);
      return next;
    });
  }, [allColumns]);

  const effectiveVisible = useMemo(() => {
    if (visibleCols.size === 0) {
      return new Set(allColumns.filter((c) => c.defaultVisible).map((c) => c.id));
    }
    return visibleCols;
  }, [visibleCols, allColumns]);

  // ── Data fetching ──────────────────────────────────────────────

  const fetchHistory = useCallback(async (fetchPage: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(fetchPage),
        limit: String(PAGE_SIZE),
        sortBy,
        sortOrder,
      });
      if (search) params.set("search", search);
      if (selectedServerId !== "all") params.set("serverId", selectedServerId);
      if (selectedTypes.size > 0) params.set("type", [...selectedTypes].join("|"));
      if (selectedUsernames.size > 0) params.set("username", [...selectedUsernames].join("|"));
      if (selectedPlatforms.size > 0) params.set("platform", [...selectedPlatforms].join("|"));
      if (selectedResolutions.size > 0) params.set("resolution", [...selectedResolutions].join("|"));

      const res = await fetch(`/api/media/history?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setItems(data.items);
      setTotalCount(data.pagination.totalCount ?? 0);
      setHasMore(data.pagination.hasMore ?? false);
      setPage(fetchPage);
      setUsernames(data.usernames ?? []);
      setPlatforms(data.platforms ?? []);
    } catch {
      setItems([]);
      setTotalCount(0);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [search, selectedServerId, selectedTypes, selectedUsernames, selectedPlatforms, selectedResolutions, sortBy, sortOrder]);

  // Reset to page 1 when filters change
  useEffect(() => {
    fetchHistory(1);
  }, [fetchHistory]);

  // ── Sort handler (server-side) ─────────────────────────────────

  const handleSortChange = useCallback((colId: string, order: "asc" | "desc") => {
    const apiSortBy = COLUMN_TO_SORT_FIELD[colId] ?? "watchedAt";
    setSortBy(apiSortBy);
    setSortOrder(order);
  }, []);

  // ── Sync handler ───────────────────────────────────────────────

  const handleSync = async () => {
    setSyncing(true);
    try {
      const body: Record<string, string> = {};
      if (selectedServerId !== "all") body.serverId = selectedServerId;
      await fetch("/api/media/history/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await fetchHistory(1);
    } finally {
      setSyncing(false);
    }
  };

  // ── Multi-select toggle helpers ────────────────────────────────

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleUsername = (username: string) => {
    setSelectedUsernames((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  };

  // ── Detail panel ──────────────────────────────────────────────

  const openDetailPanel = useCallback(async (historyItem: WatchHistoryItem) => {
    const mediaType = historyItem.mediaItem.type as "MOVIE" | "SERIES" | "MUSIC";
    setSelectedItemType(mediaType);
    setSelectedDetailUrl(getItemDetailUrl(historyItem));
    setLoadingDetail(true);
    try {
      const response = await fetch(`/api/media/${historyItem.mediaItem.id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedItem(data.item ?? data);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // ── Pagination info ───────────────────────────────────────────

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const rangeStart = (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  // Map current sortBy back to DataTable column ID for sort indicator
  const activeColumnSortId = useMemo(() => {
    const reverse = Object.fromEntries(
      Object.entries(COLUMN_TO_SORT_FIELD).map(([col, field]) => [field, col]),
    );
    return reverse[sortBy] ?? "watchedAt";
  }, [sortBy]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 overflow-x-clip">
          {/* Header */}
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Watch History</h1>
              {!loading && totalCount > 0 && (
                <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
                  {totalCount.toLocaleString()} {totalCount === 1 ? "play" : "plays"}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {syncing ? "Syncing..." : "Refresh"}
            </Button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* Search */}
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search titles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>

            {/* Server filter */}
            {servers.length > 1 && (() => {
              const dupeNames = getDuplicateServerNames(servers);
              return (
                <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                  <SelectTrigger className="w-40 h-9">
                    <SelectValue placeholder="All Servers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Servers</SelectItem>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="inline-flex items-center gap-1.5">
                          {s.name}
                          {dupeNames.has(s.name) && s.type && <ServerTypeChip type={s.type} />}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}

            {/* Type toggles */}
            <div className="flex items-center rounded-lg border h-9 p-0.5">
              {(["MOVIE", "SERIES", "MUSIC"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={cn(
                    "rounded-md px-3 h-full text-xs font-medium transition-colors",
                    selectedTypes.has(t)
                      ? TYPE_BADGE_COLORS[t]
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Username filter */}
            {usernames.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="default">
                    Users{selectedUsernames.size > 0 ? ` (${selectedUsernames.size})` : ""}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto p-2">
                  {usernames.map((u) => (
                    <label key={u} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm">
                      <Checkbox
                        checked={selectedUsernames.has(u)}
                        onCheckedChange={() => toggleUsername(u)}
                      />
                      {u}
                    </label>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Platform filter */}
            {platforms.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="default">
                    Platforms{selectedPlatforms.size > 0 ? ` (${selectedPlatforms.size})` : ""}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto p-2">
                  {platforms.map((p) => (
                    <label key={p} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm">
                      <Checkbox
                        checked={selectedPlatforms.has(p)}
                        onCheckedChange={() => togglePlatform(p)}
                      />
                      {p}
                    </label>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Column visibility */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="default" className="ml-auto">
                  <Columns3 className="mr-2 h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)] max-h-80 overflow-y-auto p-2">
                {Object.entries(COLUMN_GROUPS).map(([groupKey, groupLabel]) => {
                  const groupCols = allColumns.filter((c) => c.group === groupKey);
                  if (groupCols.length === 0) return null;
                  return (
                    <div key={groupKey} className="mb-2">
                      <div className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {groupLabel}
                      </div>
                      {groupCols.map((col) => (
                        <label
                          key={col.id}
                          className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm"
                        >
                          <Checkbox
                            checked={effectiveVisible.has(col.id)}
                            onCheckedChange={() => toggleColumn(col.id)}
                          />
                          {col.header}
                        </label>
                      ))}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 && totalCount === 0 ? (
            <EmptyState
              title="No watch history"
              description="Watch history is synced automatically during server sync. You can also click 'Refresh' to sync now."
            />
          ) : (
            <>
              <DataTable
                columns={activeColumns}
                data={items}
                onRowClick={openDetailPanel}
                keyExtractor={(item) => item.id}
                defaultSortId={activeColumnSortId}
                defaultSortOrder={sortOrder}
                onSortChange={handleSortChange}
                resizeStorageKey="history-col-widths"
                renderHoverContent={(item) => (
                  <MediaHoverPopover
                    imageUrl={`/api/media/${item.mediaItem.id}/image${item.mediaItem.type === "episode" || item.mediaItem.parentTitle ? "?type=parent" : ""}`}
                    data={{
                      title: item.mediaItem.parentTitle
                        ? `${item.mediaItem.parentTitle} — ${item.mediaItem.title}`
                        : item.mediaItem.title,
                      year: item.mediaItem.year,
                      summary: item.mediaItem.summary,
                      contentRating: item.mediaItem.contentRating,
                      rating: item.mediaItem.rating,
                      audienceRating: item.mediaItem.audienceRating,
                      ratingImage: item.mediaItem.ratingImage,
                      audienceRatingImage: item.mediaItem.audienceRatingImage,
                      duration: item.mediaItem.duration,
                      resolution: item.mediaItem.resolution,
                      dynamicRange: item.mediaItem.dynamicRange,
                      audioProfile: item.mediaItem.audioProfile,
                      fileSize: item.mediaItem.fileSize,
                      genres: item.mediaItem.genres,
                      studio: item.mediaItem.studio,
                      playCount: item.mediaItem.playCount,
                      lastPlayedAt: item.mediaItem.lastPlayedAt,
                      addedAt: item.mediaItem.addedAt,
                      servers: [{ serverId: item.server.id, serverName: item.server.name, serverType: item.server.type }],
                    }}
                  />
                )}
              />

              {/* Pagination */}
              {totalCount > 0 && (
                <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
                  <span>
                    {rangeStart.toLocaleString()}-{rangeEnd.toLocaleString()} of {totalCount.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={page <= 1}
                      onClick={() => fetchHistory(page - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="px-2 text-sm">
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={!hasMore}
                      onClick={() => fetchHistory(page + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      {/* Detail side panel */}
      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={selectedItemType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
          detailUrl={selectedDetailUrl}
        />
      )}
    </>
  );
}
