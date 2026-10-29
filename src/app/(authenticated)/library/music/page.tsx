"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChips } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover, hoverDataFromArtistGroup } from "@/components/media-hover-popover";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Music, Disc3, ListMusic, HardDrive } from "lucide-react";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { useServers } from "@/hooks/use-servers";
import { useLibraryList } from "@/hooks/use-library-list";
import { AlphabetFilter } from "@/components/alphabet-filter";
import { formatDate, formatFileSize } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { MediaGridSkeleton } from "@/components/skeletons";
import { LibraryTabs, MUSIC_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useVirtualPosterGrid, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT, useLibraryAlphabet } from "@/hooks/use-library-grid";

interface GroupedArtist {
  parentTitle: string;
  mediaItemId: string;
  trackCount: number;
  albumCount: number;
  totalSize: string;
  lastPlayed: string | null;
  addedAt: string | null;
  audioCodecCounts: Record<string, number>;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
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
  { value: "parentTitle", label: "Name" },
  { value: "albumCount", label: "Albums" },
  { value: "trackCount", label: "Tracks" },
  { value: "totalSize", label: "Size" },
  { value: "lastPlayed", label: "Last Played" },
  { value: "addedAt", label: "Date Added" },
];

// Module-level: built inline, the columns were new on every render and the
// table re-sorted the whole list on each alphabet scroll.
const ARTIST_TABLE_COLUMNS: DataTableColumn<GroupedArtist>[] = [
  {
    id: "parentTitle",
    header: "Artist",
    defaultWidth: 250,
    accessor: (a) => <span className="font-medium">{a.parentTitle}</span>,
    sortValue: (a) => a.parentTitle,
    className: "max-w-[300px] truncate",
  },
  {
    id: "albumCount",
    header: "Albums",
    defaultWidth: 90,
    accessor: (a) => a.albumCount,
    sortValue: (a) => a.albumCount,
    className: "text-muted-foreground",
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
  {
    id: "lastPlayed",
    header: "Last Played",
    defaultWidth: 120,
    accessor: (a) => formatDate(a.lastPlayed, "Never"),
    sortValue: (a) => a.lastPlayed ? new Date(a.lastPlayed).getTime() : 0,
    className: "text-muted-foreground",
  },
  {
    id: "addedAt",
    header: "Added",
    defaultWidth: 100,
    accessor: (a) => formatDate(a.addedAt),
    sortValue: (a) => a.addedAt ? new Date(a.addedAt).getTime() : 0,
    className: "text-muted-foreground",
  },
];

const artistKey = (a: GroupedArtist) => a.parentTitle;

// The table's popover carries the artist's art as its hero; the card's passes
// the same fields (the card already shows the art).
function artistTableHover(a: GroupedArtist) {
  return (
    <MediaHoverPopover
      imageUrl={`/api/media/${a.mediaItemId}/image?type=parent`}
      imageAspect="square"
      data={hoverDataFromArtistGroup(a)}
    />
  );
}

const selectArtists = (body: { artists?: GroupedArtist[] }) => body.artists;

export default function MusicPage() {
  const router = useRouter();
  const {
    viewMode,
    setViewMode,
    sortBy,
    sortOrder,
    toggleSort,
    toggleOrder,
    filters,
    externalFilters,
    onFilterChange,
    clearFilters,
    hasFilters,
  } = useLibraryListState("music", "parentTitle", { filtersKey: "filters-/library/music" });
  const filterPanel = useFilterPanelReset(externalFilters, clearFilters);
  const { show, showServers, setVisible, prefs } = useCardDisplay("MUSIC");
  const { getHex } = useChipColors();

  const { size, setSize, columns } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  const listParams = new URLSearchParams();
  listParams.set("sortBy", sortBy);
  listParams.set("sortOrder", sortOrder);
  listParams.set("limit", "0");
  if (selectedServerId !== "all") {
    listParams.set("serverId", selectedServerId);
  }
  for (const [key, value] of Object.entries(filters)) {
    if (value) listParams.set(key, value);
  }
  const { items: artistList, loading, refetch: fetchArtists } = useLibraryList({
    url: "/api/media/music/grouped",
    params: listParams,
    mode: "grouped",
    select: selectArtists,
    syncScope: { types: "MUSIC", serverId: selectedServerId },
  });

  const grid = useVirtualPosterGrid({
    count: artistList.length,
    columns,
    aspect: SQUARE_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/music", !loading && artistList.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const alphabetItems = useMemo(() => artistList.map((a) => ({ title: a.parentTitle })), [artistList]);
  const alphabet = useLibraryAlphabet(alphabetItems, grid, viewMode);

  // Summed once per list, not on every render (each alphabet scroll re-renders).
  const totals = useMemo(() => {
    let albums = 0;
    let tracks = 0;
    for (const a of artistList) {
      albums += a.albumCount;
      tracks += a.trackCount;
    }
    return { albums, tracks };
  }, [artistList]);

  const openArtist = useCallback(
    (a: GroupedArtist) => {
      markChildNavigation();
      router.push(`/library/music/artist/${a.mediaItemId}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (a: GroupedArtist, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${a.mediaItemId}/image?type=parent`}
        title={a.parentTitle}
        aspectRatio="square"
        fallbackIcon="music"
        href={`/library/music/artist/${a.mediaItemId}`}
        prefetchMediaId={a.mediaItemId}
        onClick={markChildNavigation}
        metadata={
          <MetadataLine stacked>
            {show("metadata", "albumCount") && <MetadataItem icon={<Disc3 />}>{a.albumCount} {a.albumCount === 1 ? "album" : "albums"}</MetadataItem>}
            {show("metadata", "trackCount") && <MetadataItem icon={<ListMusic />}>{a.trackCount} tracks</MetadataItem>}
            {show("metadata", "fileSize") && <MetadataItem icon={<HardDrive />}>{formatFileSize(a.totalSize)}</MetadataItem>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(
          qualityChips({ audioCodecCounts: a.audioCodecCounts }, "music"),
          getHex,
          (toggle) => show("badges", toggle),
        )}
        servers={serverChips ? a.servers : undefined}
        hoverContent={<MediaHoverPopover imageAspect="square" data={hoverDataFromArtistGroup(a)} />}
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        className="mb-6"
        title="Music"
        meta={
          !loading && artistList.length > 0 && (
            <span className="font-mono text-xs text-faint">
              {artistList.length.toLocaleString()} artists · {totals.albums.toLocaleString()} albums · {totals.tracks.toLocaleString()} songs
            </span>
          )
        }
        description="Browse your music library — grouped by artist, with deep links to albums and individual tracks."
        actions={<SyncLibraryButton libraryType="MUSIC" onSyncComplete={fetchArtists} />}
        actionsInline
      />

      <LibraryTabs tabs={MUSIC_TABS} active="/library/music" />

      <MediaFilters
        resetKey={filterPanel.resetKey}
        onFilterChange={onFilterChange}
        externalFilters={filterPanel.externalFilters}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.MUSIC}
            onCardDisplayToggle={setVisible}
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
      ) : artistList.length === 0 ? (
        <LibraryEmptyState icon={Music} noun="artists" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : viewMode === "table" ? (
        <DataTable<GroupedArtist>
          columns={ARTIST_TABLE_COLUMNS}
          data={artistList}
          keyExtractor={artistKey}
          defaultSortId="parentTitle"
          resizeStorageKey="dt-widths-music"
          onRowClick={openArtist}
          scrollToIndexRef={alphabet.tableScrollToIndexRef}
          renderHoverContent={artistTableHover}
        />
      ) : (
        <VirtualCardGrid grid={grid} items={artistList} getKey={artistKey} renderItem={renderCard} />
      )}

      <AlphabetFilter activeLetter={alphabet.activeLetter} onLetterClick={alphabet.onLetterClick} availableLetters={alphabet.availableLetters} />
    </div>
  );
}
