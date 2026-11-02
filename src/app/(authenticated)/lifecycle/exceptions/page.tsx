"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import { useMediaDetailPanel } from "@/hooks/use-media-detail-panel";
import { toDetailPanelMediaType } from "@/lib/media/detail-panel-item";
import { useRealtime } from "@/hooks/use-realtime";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { EmptyState } from "@/components/empty-state";
import { TabNav } from "@/components/tab-nav";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LoadingButton } from "@/components/loading-button";
import { PageHeader } from "@/components/page-header";
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
import { Label } from "@/components/ui/label";
import {
  Check,
  Film,
  Loader2,
  Music,
  Pencil,
  Plus,
  Search,
  ShieldOff,
  Trash2,
  Tv,
} from "lucide-react";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { formatEpisodeTitle } from "@/lib/media/display-title";

interface ExceptionItem {
  id: string;
  reason: string | null;
  createdAt: string;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    /** Series identity (src/lib/media/series-key.ts); null on movies and tracks. */
    seriesKey?: string | null;
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
    audioCodec: string | null;
    fileSize: string | null;
    genres: string[] | null;
    studio: string | null;
    playCount: number;
    seasonNumber: number | null;
    episodeNumber: number | null;
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
  /** Plays summed across the group items. */
  playCount: number;
  /** Items per resolution label (series rows). */
  qualityCounts: Record<string, number>;
  /** Items per audio codec (music rows). */
  audioCodecCounts: Record<string, number>;
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
  let playCount = 0;
  const qualityCounts: Record<string, number> = {};
  const audioCodecCounts: Record<string, number> = {};
  let lastPlayedAt: string | null = null;
  let addedAt: string | null = null;
  const serverMap = new Map<string, ServerInfo>();

  for (const e of items) {
    if (e.mediaItem.fileSize) {
      totalSize += BigInt(e.mediaItem.fileSize);
    }
    playCount += e.mediaItem.playCount ?? 0;
    // The buckets the library's own aggregates use.
    const quality = normalizeResolutionLabel(e.mediaItem.resolution);
    qualityCounts[quality] = (qualityCounts[quality] ?? 0) + 1;
    const codec = e.mediaItem.audioCodec ? e.mediaItem.audioCodec.toUpperCase() : "Unknown";
    audioCodecCounts[codec] = (audioCodecCounts[codec] ?? 0) + 1;
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
    playCount,
    qualityCounts,
    audioCodecCounts,
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
        playCount: e.mediaItem.playCount,
        qualityCounts: {},
        audioCodecCounts: {},
        lastPlayedAt: e.mediaItem.lastPlayedAt,
        addedAt: e.mediaItem.addedAt,
        servers: ms
          ? [{ serverId: ms.id, serverName: ms.name, serverType: ms.type }]
          : [],
        mediaItem: e.mediaItem,
      };
    });
  }

  // Series: group by series identity, never by title. Keyed on `parentTitle`,
  // two different shows sharing a title (The Office UK and US) became one row,
  // and Remove or Edit Reason then acted on both shows' exceptions — taking
  // the protection off a show the user never meant to touch. The same show on
  // two servers shares a key and stays one row.
  if (tab === "SERIES") {
    const groups = new Map<string, ExceptionItem[]>();
    for (const e of exceptions) {
      const key = e.mediaItem.seriesKey ?? `title:${(e.mediaItem.parentTitle ?? e.mediaItem.title).trim().toLowerCase()}`;
      const group = groups.get(key);
      if (group) {
        group.push(e);
      } else {
        groups.set(key, [e]);
      }
    }
    return [...groups.values()].map((items) => {
      const seriesName = items[0].mediaItem.parentTitle ?? items[0].mediaItem.title;
      const agg = computeAggregates(items);
      const seasons = new Set(
        items
          .map((i) => i.mediaItem.seasonNumber)
          .filter((n): n is number => n != null)
      );
      return {
        id: items[0].id,
        exceptionIds: items.map((i) => i.id),
        // One excepted episode is that episode — its show and SxxExx — not
        // the whole show its title would otherwise claim.
        displayTitle: items.length === 1 ? formatEpisodeTitle(items[0].mediaItem) : seriesName,
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

const exceptionRowKey = (row: GroupedExceptionRow) => row.id;

function getSearchResultLabel(item: SearchResult): string {
  if (item.scope === "artist") return item.title;
  if (item.scope === "album")
    return item.parentTitle ? `${item.parentTitle} — ${item.title}` : item.title;
  if (item.scope === "series") return item.title;
  // individual (movies)
  return item.parentTitle
    ? `${item.parentTitle} — ${item.title}`
    : item.title;
}

function getSearchResultSubtitle(item: SearchResult): string | null {
  if (item.scope === "artist")
    return `Artist · ${item.itemCount} ${item.itemCount === 1 ? "track" : "tracks"}`;
  if (item.scope === "album")
    return `Album · ${item.itemCount} ${item.itemCount === 1 ? "track" : "tracks"}`;
  if (item.scope === "series")
    return `${item.itemCount} ${item.itemCount === 1 ? "episode" : "episodes"}`;
  return item.year ? String(item.year) : null;
}

/**
 * "Add Exception": search the tab's media and file exceptions from the
 * results. Its search box and reason live here, so typing re-renders the
 * dialog alone — at the page, every keystroke re-rendered the table behind it.
 */
function AddExceptionDialog({
  open,
  onOpenChange,
  activeTab,
  existingMediaItemIds,
  existingGroupTitles,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: TabType;
  existingMediaItemIds: ReadonlySet<string>;
  existingGroupTitles: ReadonlySet<string>;
  /** An exception was filed: re-read the listing. */
  onAdded: () => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingItemId, setAddingItemId] = useState<string | null>(null);
  const [addReason, setAddReason] = useState("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Every opening starts with an empty search.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSearchQuery("");
      setSearchResults([]);
      setAddReason("");
    }
  }

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
        await onAdded();
        toast.success("Exception added", { description: getSearchResultLabel(item) });
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error("Couldn't add exception", { description: data.error });
      }
    } catch (error) {
      console.error("Failed to add exception:", error);
      toast.error("Couldn't add exception");
    } finally {
      setAddingItemId(null);
    }
  };

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
    <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Exception</DialogTitle>
          <DialogDescription>
            {dialogDescription}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="exception-search">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="exception-search"
                placeholder={searchPlaceholder}
                className="pl-9"
                value={searchQuery}
                onChange={(e) => handleSearchInput(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exception-reason">Reason</Label>
            <Input
              id="exception-reason"
              placeholder="Optional — applied to anything you add below"
              value={addReason}
              onChange={(e) => setAddReason(e.target.value)}
            />
          </div>
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
                  // For grouped scopes, match against display titles of existing
                  // groups: the search's representative id differs from the
                  // exceptions' own.
                  const alreadyExcluded = item.scope === "individual"
                    ? existingMediaItemIds.has(item.id)
                    : existingGroupTitles.has(getSearchResultLabel(item));
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
                          <>
                            <Check className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                            Excluded
                          </>
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
  );
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

  // Media detail panel
  const detailPanel = useMediaDetailPanel();

  // Only the latest request may write: a tab switch while the previous tab's
  // list loaded let the older response land second, and the new tab grouped
  // the other type's exceptions under its own columns.
  const exceptionsReqToken = useRef(0);
  const fetchExceptions = useCallback(async () => {
    const token = ++exceptionsReqToken.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/lifecycle/exceptions?type=${activeTab}`);
      if (response.ok) {
        const data = await response.json();
        if (token !== exceptionsReqToken.current) return;
        setExceptions(data.exceptions);
      }
    } catch (error) {
      console.error("Failed to fetch exceptions:", error);
    } finally {
      if (token === exceptionsReqToken.current) setLoading(false);
    }
  }, [activeTab]);

  // Exceptions cascade away with the media they protect, so a purge or a sync
  // that removes items silently invalidates rows this page is still rendering.
  useRealtime("sync:completed", fetchExceptions);
  useRealtime("lifecycle:action-executed", fetchExceptions);

  useEffect(() => {
    void (async () => { await fetchExceptions(); })();
  }, [fetchExceptions]);

  const groupedRows = useMemo(
    () => groupExceptions(exceptions, activeTab),
    [exceptions, activeTab]
  );

  const { open: openPanel } = detailPanel;
  const openDetailPanel = useCallback((row: GroupedExceptionRow) => {
    const mediaType = toDetailPanelMediaType(row.mediaItem.type);
    void openPanel({
      id: row.mediaItem.id,
      mediaType,
      label: row.displayTitle,
      // A series or music row stands for every excepted episode/track under
      // it — except a series row holding one episode, which is named as that
      // episode ("<Show> SxxExx") and so opens as it.
      group: mediaType === "MOVIE" || (mediaType === "SERIES" && row.itemCount === 1) ? undefined : {
        title: row.displayTitle,
        memberCount: row.itemCount,
        fileSize: row.totalSize,
        playCount: row.playCount,
        lastPlayedAt: row.lastPlayedAt,
        addedAt: row.addedAt,
      },
    });
  }, [openPanel]);

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
        if (detailPanel.selectedId === row.mediaItem.id) {
          detailPanel.close();
        }
        toast.success("Exception removed", { description: row.displayTitle });
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error("Couldn't remove exception", { description: data.error });
      }
    } catch (error) {
      console.error("Failed to remove exception:", error);
      toast.error("Couldn't remove exception");
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
        toast.success("Reason updated");
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error("Couldn't update reason", { description: data.error });
      }
    } catch (error) {
      console.error("Failed to update reason:", error);
      toast.error("Couldn't update reason");
    } finally {
      setSavingReason(false);
    }
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
            playCount: row.playCount,
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
            year: row.year,
            summary: row.mediaItem.summary,
            contentRating: row.mediaItem.contentRating,
            rating: row.mediaItem.rating,
            ratingImage: row.mediaItem.ratingImage,
            audienceRating: row.mediaItem.audienceRating,
            audienceRatingImage: row.mediaItem.audienceRatingImage,
            genres: row.mediaItem.genres,
            studio: row.mediaItem.studio,
            seasonCount: row.seasonCount,
            episodeCount: row.itemCount,
            // One excepted episode is that episode; a group's own quality
            // values would be one episode's.
            resolution: row.itemCount === 1 ? row.mediaItem.resolution : undefined,
            dynamicRange: row.itemCount === 1 ? row.mediaItem.dynamicRange : undefined,
            audioProfile: row.itemCount === 1 ? row.mediaItem.audioProfile : undefined,
            qualityCounts: row.itemCount === 1 ? undefined : row.qualityCounts,
            fileSize: row.totalSize,
            playCount: row.playCount,
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
          year: row.year,
          summary: row.mediaItem.summary,
          contentRating: row.mediaItem.contentRating,
          rating: row.mediaItem.rating,
          ratingImage: row.mediaItem.ratingImage,
          audienceRating: row.mediaItem.audienceRating,
          audienceRatingImage: row.mediaItem.audienceRatingImage,
          genres: row.mediaItem.genres,
          studio: row.mediaItem.studio,
          albumCount: row.albumCount,
          trackCount: row.itemCount,
          // An album or artist row is a group: its codecs, counted.
          audioCodecCounts: row.audioCodecCounts,
          fileSize: row.totalSize,
          playCount: row.playCount,
          lastPlayedAt: row.lastPlayedAt,
          addedAt: row.addedAt,
          servers: row.servers,
        }}
      />
    );
  }, [activeTab]);

  const isGrouped = activeTab !== "MOVIE";

  // Memoised: the table re-sorts whenever its sort column's `sortValue`
  // changes, and built inline every render re-sorted on any state change.
  const exceptionColumns = useMemo<DataTableColumn<GroupedExceptionRow>[]>(() => [
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
  ], [activeTab, isGrouped, removing]);

  const existingMediaItemIds = useMemo(() => new Set(exceptions.map((e) => e.mediaItem.id)), [exceptions]);
  // For grouped tabs, track existing group display titles so the "already excluded"
  // check works even when the search representative ID differs from exception IDs
  const existingGroupTitles = useMemo(() => {
    return new Set(groupedRows.map((r) => r.displayTitle));
  }, [groupedRows]);

  const openAddDialog = () => setShowAddDialog(true);

  return (
    <>
      <div className="space-y-6 p-4 sm:p-6 lg:p-8 overflow-y-auto h-full">
        <PageHeader
          title="Lifecycle Exceptions"
          description="Media items excluded from lifecycle actions. These items will not be matched or actioned by any rule set."
          actions={
            <Button onClick={openAddDialog} className="shrink-0">
              <Plus className="h-4 w-4 mr-2" />
              Add Exception
            </Button>
          }
        />

        {/* Tab navigation */}
        <TabNav tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : groupedRows.length === 0 ? (
          <EmptyState
            icon={ShieldOff}
            title="No exceptions"
            description={`No ${TABS.find((t) => t.value === activeTab)?.label.toLowerCase()} are excluded from lifecycle actions.`}
            action={
              <Button variant="outline" size="sm" onClick={openAddDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Exception
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldOff className="h-4 w-4" />
              <span>
                {groupedRows.length} excluded {groupedRows.length === 1
                  ? (activeTab === "MOVIE" ? "movie" : activeTab === "SERIES" ? "series" : "item")
                  : (activeTab === "MOVIE" ? "movies" : activeTab === "SERIES" ? "series" : "items")}
              </span>
            </div>
            <DataTable<GroupedExceptionRow>
              columns={exceptionColumns}
              data={groupedRows}
              keyExtractor={exceptionRowKey}
              defaultSortId="title"
              resizeStorageKey="dt-widths-exceptions"
              onRowClick={openDetailPanel}
              renderHoverContent={renderHoverContent}
            />
          </div>
        )}

        {/* Confirm removal dialog */}
        <ConfirmDialog
          open={!!confirmRemove}
          onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}
          title="Remove exception?"
          description={
            <>
              This will allow &quot;{confirmRemove?.displayTitle}&quot;
              {confirmRemove && confirmRemove.itemCount > 1
                ? ` (${confirmRemove.itemCount} ${activeTab === "SERIES" ? "episodes" : "tracks"})`
                : ""}
              {" "}to be matched and actioned by lifecycle rules again.
            </>
          }
          confirmLabel="Remove"
          onConfirm={() => {
            if (confirmRemove) void handleRemove(confirmRemove);
          }}
        />

        {/* Edit reason dialog */}
        <Dialog open={!!editingGroup} onOpenChange={(open) => { if (!open) setEditingGroup(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit exclusion reason</DialogTitle>
              <DialogDescription>
                Update the reason for excluding &quot;{editingGroup?.displayTitle}&quot;.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="edit-reason">Reason</Label>
              <Input
                id="edit-reason"
                placeholder="Optional — e.g. “Favorite show, never delete”"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                onKeyDown={(e) => {
                  // Guard against overlapping PATCH requests from rapid Enter
                  // presses (the Save button is already disabled while saving).
                  if (e.key === "Enter" && !savingReason) handleEditReason();
                }}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingGroup(null)}>
                Cancel
              </Button>
              <LoadingButton onClick={handleEditReason} loading={savingReason} iconClassName="h-4 w-4 mr-2">
                Save
              </LoadingButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AddExceptionDialog
          open={showAddDialog}
          onOpenChange={setShowAddDialog}
          activeTab={activeTab}
          existingMediaItemIds={existingMediaItemIds}
          existingGroupTitles={existingGroupTitles}
          onAdded={fetchExceptions}
        />
      </div>

      {/* Media detail side panel */}
      {detailPanel.panelProps && <MediaDetailSidePanel {...detailPanel.panelProps} />}
    </>
  );
}
