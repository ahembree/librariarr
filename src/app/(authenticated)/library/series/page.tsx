"use client";

import { useCallback, useMemo } from "react";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChips } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { useRouter } from "next/navigation";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover, hoverDataFromSeriesGroup } from "@/components/media-hover-popover";
import { useServers } from "@/hooks/use-servers";
import { useLibraryList } from "@/hooks/use-library-list";
import { LibraryToolbar } from "@/components/library-toolbar";
import { AlphabetFilter } from "@/components/alphabet-filter";
import { Tv, Layers, List, HardDrive } from "lucide-react";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatDate, formatFileSize } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { MediaGridSkeleton } from "@/components/skeletons";
import { LibraryTabs, SERIES_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useVirtualPosterGrid, POSTER_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT, useLibraryAlphabet } from "@/hooks/use-library-grid";

interface GroupedSeries {
  parentTitle: string;
  seriesKey: string | null;
  mediaItemId: string;
  episodeCount: number;
  seasonCount: number;
  totalSize: string;
  lastPlayed: string | null;
  addedAt: string | null;
  qualityCounts: Record<string, number>;
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
  { value: "seasonCount", label: "Seasons" },
  { value: "episodeCount", label: "Episodes" },
  { value: "totalSize", label: "Size" },
  { value: "lastPlayed", label: "Last Watched" },
  { value: "addedAt", label: "Date Added" },
];

// Module-level: built inline, the columns were new on every render and the
// table re-sorted the whole list on each alphabet scroll.
const SERIES_TABLE_COLUMNS: DataTableColumn<GroupedSeries>[] = [
  {
    id: "parentTitle",
    header: "Title",
    defaultWidth: 250,
    accessor: (s) => <span className="font-medium">{s.parentTitle}</span>,
    sortValue: (s) => s.parentTitle,
    className: "max-w-[300px] truncate",
  },
  {
    id: "seasonCount",
    header: "Seasons",
    defaultWidth: 90,
    accessor: (s) => s.seasonCount,
    sortValue: (s) => s.seasonCount,
    className: "text-muted-foreground",
  },
  {
    id: "episodeCount",
    header: "Episodes",
    defaultWidth: 90,
    accessor: (s) => s.episodeCount,
    sortValue: (s) => s.episodeCount,
    className: "text-muted-foreground",
  },
  {
    id: "totalSize",
    header: "Size",
    defaultWidth: 100,
    accessor: (s) => formatFileSize(s.totalSize),
    sortValue: (s) => Number(s.totalSize),
    className: "text-muted-foreground",
  },
  {
    id: "quality",
    header: "Quality",
    defaultWidth: 200,
    accessor: (s) => (
      <QualityChips chips={qualityChips({ qualityCounts: s.qualityCounts }, "video")} />
    ),
  },
  {
    id: "lastPlayed",
    header: "Last Watched",
    defaultWidth: 120,
    accessor: (s) => formatDate(s.lastPlayed, "Never"),
    sortValue: (s) => s.lastPlayed ? new Date(s.lastPlayed).getTime() : 0,
    className: "text-muted-foreground",
  },
  {
    id: "addedAt",
    header: "Added",
    defaultWidth: 100,
    accessor: (s) => formatDate(s.addedAt),
    sortValue: (s) => s.addedAt ? new Date(s.addedAt).getTime() : 0,
    className: "text-muted-foreground",
  },
];

const seriesKeyOf = (s: GroupedSeries) => s.seriesKey ?? s.parentTitle;

// The table's popover carries the show's poster as its hero; the card's passes
// the same fields (the card already shows the poster).
function seriesTableHover(s: GroupedSeries) {
  return (
    <MediaHoverPopover imageUrl={`/api/media/${s.mediaItemId}/image?type=parent`} data={hoverDataFromSeriesGroup(s)} />
  );
}

const selectSeries = (body: { series?: GroupedSeries[] }) => body.series;

export default function SeriesPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("SERIES");
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
  } = useLibraryListState("series", "parentTitle", { filtersKey: "filters-/library/series" });
  const filterPanel = useFilterPanelReset(externalFilters, clearFilters);
  const { size, setSize, columns } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  const listParams = new URLSearchParams();
  listParams.set("sortBy", sortBy);
  listParams.set("sortOrder", sortOrder);
  listParams.set("limit", "0");
  if (selectedServerId !== "all") {
    listParams.set("serverId", selectedServerId);
  }
  // Every filter goes to the server. This page used to send none and
  // filter on the client for resolution, dates and search only, so the
  // rest of the panel — Episode Count, Watched %, Last Episode Aired,
  // Watchlisted (which the route already implements), genre, year, codecs
  // — showed an active chip over an unfiltered list.
  for (const [key, value] of Object.entries(filters)) {
    if (value) listParams.set(key, value);
  }
  const { items: seriesList, loading, refetch: fetchSeries } = useLibraryList({
    url: "/api/media/series/grouped",
    params: listParams,
    mode: "grouped",
    select: selectSeries,
    syncScope: { types: "SERIES", serverId: selectedServerId },
  });

  const grid = useVirtualPosterGrid({
    count: seriesList.length,
    columns,
    aspect: POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/series", !loading && seriesList.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const alphabetItems = useMemo(() => seriesList.map((s) => ({ title: s.parentTitle })), [seriesList]);
  const alphabet = useLibraryAlphabet(alphabetItems, grid, viewMode);

  // Summed once per list, not on every render (each alphabet scroll re-renders).
  const totals = useMemo(() => {
    let seasons = 0;
    let episodes = 0;
    for (const s of seriesList) {
      seasons += s.seasonCount;
      episodes += s.episodeCount;
    }
    return { seasons, episodes };
  }, [seriesList]);

  const openShow = useCallback(
    (s: GroupedSeries) => {
      markChildNavigation();
      router.push(`/library/series/show/${s.mediaItemId}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (s: GroupedSeries, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${s.mediaItemId}/image?type=parent`}
        title={s.parentTitle}
        fallbackIcon="series"
        href={`/library/series/show/${s.mediaItemId}`}
        prefetchMediaId={s.mediaItemId}
        onClick={markChildNavigation}
        metadata={
          <MetadataLine stacked>
            {show("metadata", "seasonCount") && s.seasonCount > 0 && (
              <MetadataItem icon={<Layers />}>{s.seasonCount} {s.seasonCount === 1 ? "season" : "seasons"}</MetadataItem>
            )}
            {show("metadata", "episodeCount") && <MetadataItem icon={<List />}>{s.episodeCount} ep</MetadataItem>}
            {show("metadata", "fileSize") && <MetadataItem icon={<HardDrive />}>{formatFileSize(s.totalSize)}</MetadataItem>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(
          qualityChips({ qualityCounts: s.qualityCounts }, "video"),
          getHex,
          (toggle) => show("badges", toggle),
        )}
        servers={serverChips ? s.servers : undefined}
        hoverContent={<MediaHoverPopover data={hoverDataFromSeriesGroup(s)} />}
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        className="mb-6"
        title="Series"
        meta={
          !loading && seriesList.length > 0 && (
            <span className="font-mono text-xs text-faint">
              {seriesList.length.toLocaleString()} series · {totals.seasons.toLocaleString()} seasons · {totals.episodes.toLocaleString()} episodes
            </span>
          )
        }
        description="Browse your TV library — grouped by show, with deep links into seasons and individual episodes."
        actions={<SyncLibraryButton libraryType="SERIES" onSyncComplete={fetchSeries} />}
        actionsInline
      />

      <LibraryTabs tabs={SERIES_TABS} active="/library/series" />

      <MediaFilters
        resetKey={filterPanel.resetKey}
        onFilterChange={onFilterChange}
        externalFilters={filterPanel.externalFilters}
        mediaType="SERIES"
        seriesAggregateFilters
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.SERIES}
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
      ) : seriesList.length === 0 ? (
        <LibraryEmptyState icon={Tv} noun="series" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : viewMode === "table" ? (
        <DataTable<GroupedSeries>
          columns={SERIES_TABLE_COLUMNS}
          data={seriesList}
          keyExtractor={seriesKeyOf}
          defaultSortId="parentTitle"
          resizeStorageKey="dt-widths-series"
          onRowClick={openShow}
          scrollToIndexRef={alphabet.tableScrollToIndexRef}
          renderHoverContent={seriesTableHover}
        />
      ) : (
        <VirtualCardGrid grid={grid} items={seriesList} getKey={seriesKeyOf} renderItem={renderCard} />
      )}

      <AlphabetFilter activeLetter={alphabet.activeLetter} onLetterClick={alphabet.onLetterClick} availableLetters={alphabet.availableLetters} />
    </div>
  );
}
