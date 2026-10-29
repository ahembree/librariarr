"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { useChipColors } from "@/components/chip-color-provider";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover, hoverDataFromListItem, hoverSummaryUrl } from "@/components/media-hover-popover";
import { Film, Calendar, Clock, HardDrive } from "lucide-react";
import { MediaGridSkeleton } from "@/components/skeletons";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useLibraryList } from "@/hooks/use-library-list";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { LibraryToolbar } from "@/components/library-toolbar";
import { AlphabetFilter } from "@/components/alphabet-filter";
import type { MediaListItem } from "@/lib/types";
import { formatFileSize, formatDuration } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useVirtualPosterGrid, POSTER_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT, useLibraryAlphabet } from "@/hooks/use-library-grid";

const SORT_OPTIONS = [
  { value: "title", label: "Name" },
  { value: "year", label: "Year" },
  { value: "addedAt", label: "Date Added" },
  { value: "lastPlayedAt", label: "Last Played" },
  { value: "fileSize", label: "File Size" },
  { value: "duration", label: "Duration" },
  { value: "rating", label: "Rating" },
];

const movieKey = (movie: MediaListItem) => movie.id;

// The table's popover: the poster as its hero, since a row shows none. The
// card's passes the same fields (the card already shows the poster).
function movieTableHover(movie: MediaListItem) {
  return (
    <MediaHoverPopover
      summaryUrl={hoverSummaryUrl(movie.id)}
      imageUrl={`/api/media/${movie.id}/image`}
      data={hoverDataFromListItem(movie)}
    />
  );
}

export default function MoviesPage() {
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
  } = useLibraryListState("movies", "title", { filtersKey: "filters-/library/movies" });
  const filterPanel = useFilterPanelReset(externalFilters, clearFilters);
  const { size, setSize, columns } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("MOVIE");
  const listParams = new URLSearchParams({
    sortBy,
    sortOrder,
    ...filters,
  });
  if (selectedServerId !== "all") {
    listParams.set("serverId", selectedServerId);
  }
  const { items, loading, loadingRest, refetch: fetchMovies } = useLibraryList<MediaListItem>({
    url: "/api/media/movies",
    params: listParams,
    mode: "progressive",
    syncScope: { types: "MOVIE", serverId: selectedServerId },
    // No debounce on changes: this page has always refetched at once.
    debounceMs: 0,
  });

  const grid = useVirtualPosterGrid({
    count: items.length,
    columns,
    aspect: POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    // The grid remounts behind the skeleton and on a view switch.
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/movies", !loadingRest && items.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const alphabetItems = useMemo(() => items.map((m) => ({ title: m.titleSort || m.title })), [items]);
  const alphabet = useLibraryAlphabet(alphabetItems, grid, viewMode);

  const openMovie = useCallback(
    (item: MediaListItem) => {
      markChildNavigation();
      router.push(`/library/movies/${item.id}`);
    },
    [markChildNavigation, router],
  );

  // Stable while the display preferences hold, so a virtualizer range change
  // or the rest of the library landing re-renders no mounted card.
  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (movie: MediaListItem, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${movie.id}/image`}
        title={movie.title}
        fallbackIcon="movie"
        href={`/library/movies/${movie.id}`}
        prefetchMediaId={movie.id}
        onClick={markChildNavigation}
        metadata={
          <MetadataLine stacked>
            {show("metadata", "year") && movie.year && <MetadataItem icon={<Calendar />}>{movie.year}</MetadataItem>}
            {show("metadata", "duration") && formatDuration(movie.duration) && <MetadataItem icon={<Clock />}>{formatDuration(movie.duration)}</MetadataItem>}
            {show("metadata", "fileSize") && formatFileSize(movie.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(movie.fileSize)}</MetadataItem>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(qualityChips(movie, "video"), getHex, (toggle) => show("badges", toggle))}
        servers={serverChips ? movie.servers : undefined}
        hoverContent={<MediaHoverPopover summaryUrl={hoverSummaryUrl(movie.id)} data={hoverDataFromListItem(movie)} />}
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        className="mb-6"
        title="Movies"
        meta={
          !loadingRest && items.length > 0 && (
            <span className="font-mono text-xs text-faint">
              {items.length.toLocaleString()} {items.length === 1 ? "movie" : "movies"}
            </span>
          )
        }
        description="Browse your movie library — filter by quality, year, genre, and more."
        actions={<SyncLibraryButton libraryType="MOVIE" onSyncComplete={fetchMovies} />}
        actionsInline
      />

      <MediaFilters
        resetKey={filterPanel.resetKey}
        onFilterChange={onFilterChange}
        externalFilters={filterPanel.externalFilters}
        streamCountFilters
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.MOVIE}
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
      ) : items.length === 0 ? (
        <LibraryEmptyState icon={Film} noun="movies" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : viewMode === "table" ? (
        <MediaTable
          items={items}
          onItemClick={openMovie}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={toggleSort}
          mediaType="MOVIE"
          scrollToIndexRef={alphabet.tableScrollToIndexRef}
          hideServers={servers.length <= 1}
          renderHoverContent={movieTableHover}
        />
      ) : (
        <VirtualCardGrid grid={grid} items={items} getKey={movieKey} renderItem={renderCard} />
      )}

      <AlphabetFilter
        activeLetter={alphabet.activeLetter}
        onLetterClick={alphabet.onLetterClick}
        availableLetters={alphabet.availableLetters}
      />
    </div>
  );
}
