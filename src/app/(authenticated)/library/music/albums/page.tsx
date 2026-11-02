"use client";

import { useCallback } from "react";
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
import { useLibraryList } from "@/hooks/use-library-list";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
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

const selectAlbums = (body: { albums?: AlbumEntry[] }) => body.albums;

export default function AllAlbumsPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { viewMode, setViewMode, sortBy, sortOrder, toggleSort, toggleOrder, filters, onFilterChange, clearFilters, hasFilters } =
    useLibraryListState("albums", "albumTitle");
  const filterPanel = useFilterPanelReset(undefined, clearFilters);

  const { size, setSize, columns } = useCardSize();
  const { show: showCardBadge, showServers, prefs: cardDisplayPrefs, setVisible: setCardDisplayVisible } = useCardDisplay("MUSIC_ALBUMS");
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  const listParams = new URLSearchParams();
  listParams.set("limit", "0");
  listParams.set("sortBy", sortBy);
  listParams.set("sortOrder", sortOrder);
  if (selectedServerId !== "all") {
    listParams.set("serverId", selectedServerId);
  }
  for (const [key, value] of Object.entries(filters)) {
    if (value) listParams.set(key, value);
  }
  const { items: albums, loading } = useLibraryList({
    url: "/api/media/music/albums/all",
    params: listParams,
    mode: "grouped",
    select: selectAlbums,
    syncScope: { types: "MUSIC", serverId: selectedServerId },
  });

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
