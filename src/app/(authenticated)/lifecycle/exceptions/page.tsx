"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  ShieldOff,
  Trash2,
  Pencil,
  Plus,
  Search,
  Film,
  Tv,
  Music,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaItemWithRelations } from "@/lib/types";

interface ExceptionItem {
  id: string;
  reason: string | null;
  createdAt: string;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    albumTitle?: string | null;
    type: string;
    year: number | null;
    thumbUrl: string | null;
    summary: string | null;
    contentRating: string | null;
    rating: number | null;
    ratingImage: string | null;
    audienceRating: number | null;
    audienceRatingImage: string | null;
    duration: number | null;
    resolution: string | null;
    dynamicRange: string | null;
    audioProfile: string | null;
    fileSize: string | null;
    genres: string[] | null;
    studio: string | null;
    playCount: number;
    seasonNumber: number | null;
    lastPlayedAt: string | null;
    addedAt: string | null;
    library?: {
      mediaServer: {
        id: string;
        name: string;
        type: string;
      };
    };
  };
}

interface ServerInfo {
  serverId: string;
  serverName: string;
  serverType: string;
}

/** A grouped row representing one or more underlying ExceptionItems. */
interface GroupedExceptionRow {
  /** Stable key for the row (first exception's id). */
  id: string;
  /** All exception IDs in the group. */
  exceptionIds: string[];
  /** Display title (series name, artist, or artist — album). */
  displayTitle: string;
  /** Number of underlying items (episodes/tracks). */
  itemCount: number;
  reason: string | null;
  createdAt: string;
  year: number | null;
  /** Aggregated total file size (stringified BigInt sum). */
  totalSize: string | null;
  /** Number of distinct seasons (series only). */
  seasonCount?: number;
  /** Number of distinct albums (music artist only). */
  albumCount?: number;
  /** Most recent lastPlayedAt across group items. */
  lastPlayedAt: string | null;
  /** Earliest addedAt across group items. */
  addedAt: string | null;
  /** Unique servers that hold items in this group. */
  servers: ServerInfo[];
  /** Representative media item (first in group) for detail panel. */
  mediaItem: ExceptionItem["mediaItem"];
}

interface SearchResult {
  id: string;
  title: string;
  parentTitle: string | null;
  albumTitle?: string | null;
  year: number | null;
  type: string;
  scope: "individual" | "series" | "artist" | "album";
  itemCount?: number;
}

type TabType = "MOVIE" | "SERIES" | "MUSIC";

const TABS: { value: TabType; label: string; icon: typeof Film }[] = [
  { value: "MOVIE", label: "Movies", icon: Film },
  { value: "SERIES", label: "Series", icon: Tv },
  { value: "MUSIC", label: "Music", icon: Music },
];

function computeAggregates(items: ExceptionItem[]) {
  let totalSize = BigInt(0);
  let lastPlayedAt: string | null = null;
  let addedAt: string | null = null;
  const serverMap = new Map<string, ServerInfo>();

  for (const e of items) {
    if (e.mediaItem.fileSize) {
      totalSize += BigInt(e.mediaItem.fileSize);
    }
    if (e.mediaItem.lastPlayedAt) {
      if (!lastPlayedAt || e.mediaItem.lastPlayedAt > lastPlayedAt) {
        lastPlayedAt = e.mediaItem.lastPlayedAt;
      }
    }
    if (e.mediaItem.addedAt) {
      if (!addedAt || e.mediaItem.addedAt < addedAt) {
        addedAt = e.mediaItem.addedAt;
      }
    }
    const ms = e.mediaItem.library?.mediaServer;
    if (ms && !serverMap.has(ms.id)) {
      serverMap.set(ms.id, {
        serverId: ms.id,
        serverName: ms.name,
        serverType: ms.type,
      });
    }
  }

  return {
    totalSize: totalSize > 0 ? totalSize.toString() : null,
    lastPlayedAt,
    addedAt,
    servers: [...serverMap.values()].sort((a, b) =>
      a.serverName.localeCompare(b.serverName)
    ),
  };
}

function groupExceptions(
  exceptions: ExceptionItem[],
  tab: TabType
): GroupedExceptionRow[] {
  // Movies: no grouping, 1:1 mapping
  if (tab === "MOVIE") {
    return exceptions.map((e) => {
      const ms = e.mediaItem.library?.mediaServer;
      return {
        id: e.id,
        exceptionIds: [e.id],
        displayTitle: e.mediaItem.title,
        itemCount: 1,
        reason: e.reason,
        createdAt: e.createdAt,
        year: e.mediaItem.year,
        totalSize: e.mediaItem.fileSize,
        lastPlayedAt: e.mediaItem.lastPlayedAt,
        addedAt: e.mediaItem.addedAt,
        servers: ms
          ? [{ serverId: ms.id, serverName: ms.name, serverType: ms.type }]
          : [],
        mediaItem: e.mediaItem,
      };
    });
  }

  // Series: group by parentTitle
  if (tab === "SERIES") {
    const groups = new Map<string, ExceptionItem[]>();
    for (const e of exceptions) {
      const key = e.mediaItem.parentTitle ?? e.mediaItem.title;
      const group = groups.get(key);
      if (group) {
        group.push(e);
      } else {
        groups.set(key, [e]);
      }
    }
    return [...groups.entries()].map(([seriesName, items]) => {
      const agg = computeAggregates(items);
      const seasons = new Set(
        items
          .map((i) => i.mediaItem.seasonNumber)
          .filter((n): n is number => n != null)
      );
      return {
        id: items[0].id,
        exceptionIds: items.map((i) => i.id),
        displayTitle: seriesName,
        itemCount: items.length,
        seasonCount: seasons.size || undefined,
        reason: items[0].reason,
        createdAt: items[0].createdAt,
        year: items[0].mediaItem.year,
        mediaItem: items[0].mediaItem,
        ...agg,
      };
    });
  }

  // Music: group by (parentTitle, albumTitle)
  const groups = new Map<string, ExceptionItem[]>();
  for (const e of exceptions) {
    const artist = e.mediaItem.parentTitle ?? "";
    const album = e.mediaItem.albumTitle ?? "";
    const key = `${artist}::${album}`;
    const group = groups.get(key);
    if (group) {
      group.push(e);
    } else {
      groups.set(key, [e]);
    }
  }
  return [...groups.entries()].map(([, items]) => {
    const artist = items[0].mediaItem.parentTitle;
    const album = items[0].mediaItem.albumTitle;
    const displayTitle = artist && album
      ? `${artist} — ${album}`
      : artist ?? items[0].mediaItem.title;
    const agg = computeAggregates(items);
    const albums = new Set(
      items
        .map((i) => i.mediaItem.albumTitle)
        .filter((a): a is string => a != null)
    );
    return {
      id: items[0].id,
      exceptionIds: items.map((i) => i.id),
      displayTitle,
      itemCount: items.length,
      albumCount: albums.size || undefined,
      reason: items[0].reason,
      createdAt: items[0].createdAt,
      year: items[0].mediaItem.year,
      mediaItem: items[0].mediaItem,
      ...agg,
    };
  });
}

export default function LifecycleExceptionsPage() {
  const [activeTab, setActiveTab] = useState<TabType>("MOVIE");
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<GroupedExceptionRow | null>(null);

  // Edit reason
  const [editingGroup, setEditingGroup] = useState<GroupedExceptionRow | null>(null);
  const [editReason, setEditReason] = useState("");
  const [savingReason, setSavingReason] = useState(false);

  // Add manually
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingItemId, setAddingItemId] = useState<string | null>(null);
  const [addReason, setAddReason] = useState("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Media detail panel
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [selectedDetailUrl, setSelectedDetailUrl] = useState<string | undefined>();
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "lifecycle-exceptions-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });

  const fetchExceptions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/lifecycle/exceptions?type=${activeTab}`);
      if (response.ok) {
        const data = await response.json();
        setExceptions(data.exceptions);
      }
    } catch (error) {
      console.error("Failed to fetch exceptions:", error);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchExceptions();
  }, [fetchExceptions]);

  const groupedRows = useMemo(
    () => groupExceptions(exceptions, activeTab),
    [exceptions, activeTab]
  );

  const openDetailPanel = async (row: GroupedExceptionRow) => {
    const mediaType = row.mediaItem.type as "MOVIE" | "SERIES" | "MUSIC";
    setSelectedItemType(mediaType);

    try {
      const response = await fetch(`/api/media/${row.mediaItem.id}`);
      if (!response.ok) return;
      const data = await response.json();
      const rawItem: MediaItemWithRelations = data.item ?? data;

      if (mediaType === "MOVIE") {
        setSelectedDetailUrl(undefined);
        setSelectedItem(rawItem);
      } else {
        // Series/Music: construct a top-level aggregate view
        const topLevelItem: MediaItemWithRelations = {
          ...rawItem,
          title: row.displayTitle,
          parentTitle: null,
          matchedEpisodes: row.itemCount,
          fileSize: row.totalSize,
        };
        const detailUrl = mediaType === "SERIES"
          ? `/library/series/show/${row.mediaItem.id}`
          : `/library/music/artist/${row.mediaItem.id}`;
        setSelectedDetailUrl(detailUrl);
        setSelectedItem(topLevelItem);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    }
  };

  const handleRemove = async (row: GroupedExceptionRow) => {
    setRemoving(row.id);
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: row.exceptionIds }),
      });
      if (response.ok) {
        const removedIds = new Set(row.exceptionIds);
        setExceptions((prev) => prev.filter((e) => !removedIds.has(e.id)));
        if (selectedItem && selectedItem.id === row.mediaItem.id) {
          setSelectedItem(null);
        }
      }
    } catch (error) {
      console.error("Failed to remove exception:", error);
    } finally {
      setRemoving(null);
      setConfirmRemove(null);
    }
  };

  const handleEditReason = async () => {
    if (!editingGroup) return;
    setSavingReason(true);
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: editingGroup.exceptionIds,
          reason: editReason || undefined,
        }),
      });
      if (response.ok) {
        const updatedIds = new Set(editingGroup.exceptionIds);
        setExceptions((prev) =>
          prev.map((e) =>
            updatedIds.has(e.id) ? { ...e, reason: editReason || null } : e
          )
        );
        setEditingGroup(null);
      }
    } catch (error) {
      console.error("Failed to update reason:", error);
    } finally {
      setSavingReason(false);
    }
  };

  // Search for media items to add manually
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: query, type: activeTab });
      if (activeTab === "SERIES") params.set("seriesScope", "true");
      if (activeTab === "MUSIC") params.set("musicScope", "true");
      const response = await fetch(`/api/media/search?${params}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.items || []);
      }
    } catch (error) {
      console.error("Failed to search media:", error);
    } finally {
      setSearching(false);
    }
  }, [activeTab]);

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      handleSearch(value);
    }, 300);
  };

  const handleAddException = async (item: SearchResult) => {
    setAddingItemId(item.id);
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaItemId: item.id,
          reason: addReason || undefined,
          scope: item.scope,
        }),
      });
      if (response.ok) {
        // Remove from search results and refresh exceptions
        setSearchResults((prev) => prev.filter((r) => r.id !== item.id));
        await fetchExceptions();
      }
    } catch (error) {
      console.error("Failed to add exception:", error);
    } finally {
      setAddingItemId(null);
    }
  };

  const getSearchResultLabel = (item: SearchResult) => {
    if (item.scope === "artist") return item.title;
    if (item.scope === "album")
      return item.parentTitle ? `${item.parentTitle} — ${item.title}` : item.title;
    if (item.scope === "series") return item.title;
    // individual (movies)
    return item.parentTitle
      ? `${item.parentTitle} — ${item.title}`
      : item.title;
  };

  const getSearchResultSubtitle = (item: SearchResult) => {
    if (item.scope === "artist")
      return `Artist · ${item.itemCount} ${item.itemCount === 1 ? "track" : "tracks"}`;
    if (item.scope === "album")
      return `Album · ${item.itemCount} ${item.itemCount === 1 ? "track" : "tracks"}`;
    if (item.scope === "series")
      return `${item.itemCount} ${item.itemCount === 1 ? "episode" : "episodes"}`;
    return item.year ? String(item.year) : null;
  };

  const renderHoverContent = useCallback((row: GroupedExceptionRow) => {
    const isMovie = activeTab === "MOVIE";
    const isMusic = activeTab === "MUSIC";
    const imageType = isMovie ? "" : "?type=parent";

    if (isMovie) {
      return (
        <MediaHoverPopover
          imageUrl={`/api/media/${row.mediaItem.id}/image`}
          data={{
            title: row.displayTitle,
            year: row.year,
            summary: row.mediaItem.summary,
            contentRating: row.mediaItem.contentRating,
            rating: row.mediaItem.rating,
            audienceRating: row.mediaItem.audienceRating,
            ratingImage: row.mediaItem.ratingImage,
            audienceRatingImage: row.mediaItem.audienceRatingImage,
            duration: row.mediaItem.duration,
            resolution: row.mediaItem.resolution,
            dynamicRange: row.mediaItem.dynamicRange,
            audioProfile: row.mediaItem.audioProfile,
            fileSize: row.totalSize,
            genres: row.mediaItem.genres,
            studio: row.mediaItem.studio,
            playCount: row.mediaItem.playCount,
            lastPlayedAt: row.lastPlayedAt,
            addedAt: row.addedAt,
            servers: row.servers,
          }}
        />
      );
    }

    if (activeTab === "SERIES") {
      return (
        <MediaHoverPopover
          imageUrl={`/api/media/${row.mediaItem.id}/image${imageType}`}
          data={{
            title: row.displayTitle,
            seasonCount: row.seasonCount,
            episodeCount: row.itemCount,
            fileSize: row.totalSize,
            lastPlayedAt: row.lastPlayedAt,
            addedAt: row.addedAt,
            servers: row.servers,
          }}
        />
      );
    }

    // Music
    return (
      <MediaHoverPopover
        imageUrl={`/api/media/${row.mediaItem.id}/image${imageType}`}
        imageAspect={isMusic ? "square" : "poster"}
        data={{
          title: row.displayTitle,
          albumCount: row.albumCount,
          trackCount: row.itemCount,
          fileSize: row.totalSize,
          lastPlayedAt: row.lastPlayedAt,
          addedAt: row.addedAt,
          servers: row.servers,
        }}
      />
    );
  }, [activeTab]);

  const isGrouped = activeTab !== "MOVIE";

  const exceptionColumns: DataTableColumn<GroupedExceptionRow>[] = [
    {
      id: "title",
      header: "Title",
      defaultWidth: 300,
      sortable: true,
      accessor: (row) => (
        <div className="min-w-0">
          <span className="truncate max-w-xs font-medium block">
            {row.displayTitle}
          </span>
          {isGrouped && row.itemCount > 1 && (
            <span className="text-xs text-muted-foreground">
              {activeTab === "SERIES"
                ? `${row.itemCount} ${row.itemCount === 1 ? "episode" : "episodes"}`
                : `${row.itemCount} ${row.itemCount === 1 ? "track" : "tracks"}`}
            </span>
          )}
        </div>
      ),
      sortValue: (row) => row.displayTitle,
    },
    {
      id: "year",
      header: "Year",
      defaultWidth: 80,
      sortable: true,
      className: "text-muted-foreground",
      accessor: (row) => row.year ?? "—",
      sortValue: (row) => row.year ?? 0,
    },
    {
      id: "reason",
      header: "Reason",
      defaultWidth: 200,
      className: "text-muted-foreground",
      accessor: (row) => (
        <span className="truncate max-w-xs block">
          {row.reason || "—"}
        </span>
      ),
    },
    {
      id: "createdAt",
      header: "Date Added",
      defaultWidth: 140,
      sortable: true,
      className: "text-muted-foreground text-sm",
      accessor: (row) => new Date(row.createdAt).toLocaleDateString(),
      sortValue: (row) => new Date(row.createdAt).getTime(),
    },
    {
      id: "actions",
      header: "",
      defaultWidth: 100,
      accessor: (row) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setEditingGroup(row);
              setEditReason(row.reason || "");
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmRemove(row)}
            disabled={removing === row.id}
          >
            {removing === row.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      ),
    },
  ];

  const existingMediaItemIds = new Set(exceptions.map((e) => e.mediaItem.id));
  // For grouped tabs, track existing group display titles so the "already excluded"
  // check works even when the search representative ID differs from exception IDs
  const existingGroupTitles = useMemo(() => {
    return new Set(groupedRows.map((r) => r.displayTitle));
  }, [groupedRows]);

  const searchPlaceholder =
    activeTab === "MOVIE"
      ? "Search by title..."
      : activeTab === "SERIES"
        ? "Search by series name..."
        : "Search by artist or album...";

  const dialogDescription =
    activeTab === "MOVIE"
      ? "Search for a movie to exclude from lifecycle actions."
      : activeTab === "SERIES"
        ? "Search for a series to exclude all its episodes from lifecycle actions."
        : "Search for an artist or album to exclude from lifecycle actions.";

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 space-y-6 p-6 overflow-y-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Lifecycle Exceptions</h1>
            <p className="text-muted-foreground">
              Media items excluded from lifecycle actions. These items will not be matched or actioned by any rule set.
            </p>
          </div>
          <Button onClick={() => {
            setShowAddDialog(true);
            setSearchQuery("");
            setSearchResults([]);
            setAddReason("");
          }}>
            <Plus className="h-4 w-4 mr-2" />
            Add Exception
          </Button>
        </div>

        {/* Tab navigation */}
        <nav className="flex items-center gap-1 border-b overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cn(
                  "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0",
                  activeTab === tab.value
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : groupedRows.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <ShieldOff className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <CardTitle className="text-lg mb-2">No exceptions</CardTitle>
              <p className="text-muted-foreground text-sm">
                No {TABS.find((t) => t.value === activeTab)?.label.toLowerCase()} are excluded from lifecycle actions.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {groupedRows.length} excluded {groupedRows.length === 1
                  ? (activeTab === "MOVIE" ? "movie" : activeTab === "SERIES" ? "series" : "item")
                  : (activeTab === "MOVIE" ? "movies" : activeTab === "SERIES" ? "series" : "items")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DataTable<GroupedExceptionRow>
                columns={exceptionColumns}
                data={groupedRows}
                keyExtractor={(row) => row.id}
                defaultSortId="title"
                resizeStorageKey="dt-widths-exceptions"
                onRowClick={(row) => openDetailPanel(row)}
                renderHoverContent={renderHoverContent}
              />
            </CardContent>
          </Card>
        )}

        {/* Confirm removal dialog */}
        <AlertDialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove exception?</AlertDialogTitle>
              <AlertDialogDescription>
                This will allow &quot;{confirmRemove?.displayTitle}&quot;
                {confirmRemove && confirmRemove.itemCount > 1
                  ? ` (${confirmRemove.itemCount} ${activeTab === "SERIES" ? "episodes" : "tracks"})`
                  : ""}
                {" "}to be matched and actioned by lifecycle rules again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => confirmRemove && handleRemove(confirmRemove)}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Edit reason dialog */}
        <Dialog open={!!editingGroup} onOpenChange={(open) => { if (!open) setEditingGroup(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit exclusion reason</DialogTitle>
              <DialogDescription>
                Update the reason for excluding &quot;{editingGroup?.displayTitle}&quot;.
              </DialogDescription>
            </DialogHeader>
            <Input
              placeholder="Reason (optional)"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditReason();
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingGroup(null)}>
                Cancel
              </Button>
              <Button onClick={handleEditReason} disabled={savingReason}>
                {savingReason ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add exception dialog */}
        <Dialog open={showAddDialog} onOpenChange={(open) => { if (!open) setShowAddDialog(false); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Exception</DialogTitle>
              <DialogDescription>
                {dialogDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  autoFocus
                />
              </div>
              <Input
                placeholder="Reason (optional)"
                value={addReason}
                onChange={(e) => setAddReason(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {searching ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {searchQuery.trim() ? "No results found." : "Type to search for media items."}
                  </div>
                ) : (
                  <div className="divide-y">
                    {searchResults.map((item) => {
                      const alreadyExcluded = (() => {
                        if (item.scope === "individual")
                          return existingMediaItemIds.has(item.id);
                        // For grouped scopes, match against display titles of existing groups
                        const label = getSearchResultLabel(item);
                        return existingGroupTitles.has(label);
                      })();
                      const subtitle = getSearchResultSubtitle(item);
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/50"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {getSearchResultLabel(item)}
                            </p>
                            {subtitle && (
                              <p className="text-xs text-muted-foreground">{subtitle}</p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-3 shrink-0"
                            disabled={alreadyExcluded || addingItemId === item.id}
                            onClick={() => handleAddException(item)}
                          >
                            {addingItemId === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : alreadyExcluded ? (
                              "Excluded"
                            ) : (
                              <>
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                Add
                              </>
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Media detail side panel */}
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
    </div>
  );
}
