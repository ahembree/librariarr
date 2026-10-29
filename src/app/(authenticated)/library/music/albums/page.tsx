"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MediaCard } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChips } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { MediaFilters } from "@/components/media-filters";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Music, Disc3, ListMusic, HardDrive } from "lucide-react";
import { MediaHoverPopover, hoverDataFromAlbum } from "@/components/media-hover-popover";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useShownList } from "@/hooks/use-shown-list";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { useVirtualPosterGrid, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { MediaGridSkeleton } from "@/components/skeletons";
import { LibraryTabs, MUSIC_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { listCacheKeyFor, loadCachedList } from "@/lib/media/list-cache";

interface AlbumEntry {
  albumTitle: string;
  artistName: string;
  trackCount: number;
  totalSize: string;
  audioCodecCounts: Record<string, number>;
  mediaItemId: string;
  totalPlayCount: number;
  lastPlayed: string | null;
  addedAt: string | null;
  servers: { serverId: string; serverName: string; serverType: string }[];
  summary?: string | null;
  genres?: string[] | null;
  studio?: string | null;
  contentRating?: string | null;
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  year?: number | null;
}

const SORT_OPTIONS = [
  { value: "albumTitle", label: "Name" },
  { value: "artistName", label: "Artist" },
  { value: "trackCount", label: "Tracks" },
  { value: "totalSize", label: "Size" },
];

// Module-level: built inline, the columns were new on every render and the
// table re-sorted the whole list each time.
const ALBUM_TABLE_COLUMNS: DataTableColumn<AlbumEntry>[] = [
  {
    id: "albumTitle",
    header: "Album",
    defaultWidth: 250,
    accessor: (a) => <span className="font-medium">{a.albumTitle}</span>,
    sortValue: (a) => a.albumTitle,
    className: "max-w-[300px] truncate",
  },
  {
    id: "artistName",
    header: "Artist",
    defaultWidth: 200,
    accessor: (a) => a.artistName,
    sortValue: (a) => a.artistName,
    className: "text-muted-foreground max-w-[200px] truncate",
  },
  {
    id: "trackCount",
    header: "Tracks",
    defaultWidth: 90,
    accessor: (a) => a.trackCount,
    sortValue: (a) => a.trackCount,
    className: "text-muted-foreground",
  },
  {
    id: "totalSize",
    header: "Size",
    defaultWidth: 100,
    accessor: (a) => formatFileSize(a.totalSize),
    sortValue: (a) => Number(a.totalSize),
    className: "text-muted-foreground",
  },
  {
    id: "codecs",
    header: "Codecs",
    defaultWidth: 200,
    accessor: (a) => (
      <QualityChips chips={qualityChips({ audioCodecCounts: a.audioCodecCounts }, "music")} />
    ),
  },
];

const ALBUMS_FROM = `?from=${encodeURIComponent("/library/music/albums")}`;

const albumKey = (a: AlbumEntry) => `${a.artistName}::${a.albumTitle}`;

// The same popover, with the album art as its hero, in both views.
function albumHover(album: AlbumEntry) {
  return (
    <MediaHoverPopover
      imageUrl={`/api/media/${album.mediaItemId}/image?type=season`}
      imageAspect="square"
      data={hoverDataFromAlbum(album)}
    />
  );
}

export default function AllAlbumsPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode, setViewMode, sortBy, sortOrder, toggleSort, toggleOrder, filters, onFilterChange, clearFilters, hasFilters } =
    useLibraryListState("albums", "albumTitle");
  const filterPanel = useFilterPanelReset(undefined, clearFilters);

  const { size, setSize, columns } = useCardSize();
  const { show: showCardBadge, showServers, prefs: cardDisplayPrefs, setVisible: setCardDisplayVisible } = useCardDisplay("MUSIC_ALBUMS");
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  // Guards against a stale slow response landing after a quick
  // sort/filter/server flip and showing the wrong items for the selection.
  const latest = useLatestRequest();
  const shown = useShownList();

  const grid = useVirtualPosterGrid({
    count: albums.length,
    columns,
    aspect: SQUARE_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/music/albums", !loading && albums.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const fetchAlbums = useCallback(async () => {
    const token = latest.begin();
    const params = new URLSearchParams();
    params.set("limit", "0");
    params.set("sortBy", sortBy);
    params.set("sortOrder", sortOrder);
    if (selectedServerId !== "all") {
      params.set("serverId", selectedServerId);
    }
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    const listKey = listCacheKeyFor("/api/media/music/albums/all", params);
    // A refetch of the list already on screen (a sync added or removed items)
    // swaps the new list in where the old one stands, with no skeleton.
    const refresh = shown.begin(listKey);
    if (!refresh) setLoading(true);
    // Set once this request's list is on screen, from the cache or the server.
    let applied = false;
    try {
      // Through the tab's list cache: a list loaded in the last minute is
      // shown at once, an older one shown and then refreshed behind it.
      await loadCachedList<{ albums?: AlbumEntry[] }>("/api/media/music/albums/all", params, (data) => {
        if (!latest.isCurrent(token)) return;
        applied = true;
        shown.markShown(listKey);
        setAlbums(data.albums || []);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch albums:", error);
      // A failed load with nothing shown for it empties the list, as it did
      // before the cache: the previous list under the new filters would read
      // as their result. A failed refresh leaves the list on screen as it was.
      if (!applied && !refresh && latest.isCurrent(token)) setAlbums([]);
    } finally {
      if (latest.isCurrent(token)) setLoading(false);
    }
  }, [filters, sortBy, sortOrder, selectedServerId, latest, shown]);

  useListFetch(fetchAlbums);

  // Auto-update when real-time sync adds/removes items — no manual refresh.
  useLibrarySyncRefetch({ types: "MUSIC", serverId: selectedServerId }, fetchAlbums);

  const openAlbum = useCallback(
    (a: AlbumEntry) => {
      markChildNavigation();
      router.push(`/library/music/album/${a.mediaItemId}${ALBUMS_FROM}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (album: AlbumEntry, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${album.mediaItemId}/image?type=season`}
        title={album.albumTitle}
        aspectRatio="square"
        fallbackIcon="music"
        href={`/library/music/album/${album.mediaItemId}${ALBUMS_FROM}`}
        prefetchMediaId={album.mediaItemId}
        onClick={markChildNavigation}
        qualityBar={qualitySegments(
          qualityChips({ audioCodecCounts: album.audioCodecCounts }, "music"),
          getHex,
          (toggle) => showCardBadge("badges", toggle),
        )}
        servers={serverChips ? album.servers : undefined}
        hoverContent={albumHover(album)}
        metadata={
          <MetadataLine stacked>
            <MetadataItem icon={<Music />}>
              {album.artistName}
            </MetadataItem>
            <MetadataItem icon={<ListMusic />}>
              {album.trackCount}{" "}
              {album.trackCount === 1 ? "track" : "tracks"}
            </MetadataItem>
            <MetadataItem icon={<HardDrive />}>
              {formatFileSize(album.totalSize)}
            </MetadataItem>
          </MetadataLine>
        }
      />
    ),
    [showCardBadge, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader className="mb-4" title="Music" />

      <LibraryTabs tabs={MUSIC_TABS} active="/library/music/albums" />

      <MediaFilters
        resetKey={filterPanel.resetKey}
        onFilterChange={onFilterChange}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={cardDisplayPrefs}
            cardDisplayConfig={TOGGLE_CONFIGS.MUSIC_ALBUMS}
            onCardDisplayToggle={setCardDisplayVisible}
            servers={servers}
            selectedServerId={selectedServerId}
            onServerChange={setSelectedServerId}
            sortOptions={SORT_OPTIONS}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={toggleSort}
            onSortOrderToggle={toggleOrder}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : albums.length === 0 ? (
        <LibraryEmptyState icon={Disc3} noun="albums" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {albums.length} {albums.length === 1 ? "album" : "albums"}
          </p>

          {viewMode === "table" ? (
            <DataTable<AlbumEntry>
              columns={ALBUM_TABLE_COLUMNS}
              data={albums}
              keyExtractor={albumKey}
              defaultSortId="albumTitle"
              resizeStorageKey="dt-widths-albums"
              onRowClick={openAlbum}
              renderHoverContent={albumHover}
            />
          ) : (
            <VirtualCardGrid grid={grid} items={albums} getKey={albumKey} renderItem={renderCard} />
          )}
        </>
      )}
    </div>
  );
}
