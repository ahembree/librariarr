"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChips } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover, hoverDataFromSeason } from "@/components/media-hover-popover";
import { seasonHoverTitle } from "@/lib/media/hover-data";
import { MediaFilters } from "@/components/media-filters";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Tv, List, HardDrive, Play } from "lucide-react";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { useVirtualPosterGrid, POSTER_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatDate, formatFileSize } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { MediaGridSkeleton } from "@/components/skeletons";
import { LibraryTabs, SERIES_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { loadCachedList } from "@/lib/media/list-cache";

interface SeasonEntry {
  parentTitle: string;
  seriesKey: string | null;
  seasonNumber: number;
  mediaItemId: string;
  episodeCount: number;
  totalSize: string;
  lastPlayed: string | null;
  addedAt: string | null;
  totalPlayCount: number;
  qualityCounts: Record<string, number>;
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
  { value: "parentTitle", label: "Series Name" },
  { value: "seasonNumber", label: "Season Number" },
  { value: "episodeCount", label: "Episodes" },
  { value: "totalSize", label: "Size" },
  { value: "lastPlayed", label: "Last Watched" },
  { value: "addedAt", label: "Date Added" },
];

// Module-level: built inline, the columns were new on every render and the
// table re-sorted the whole list each time.
const SEASON_TABLE_COLUMNS: DataTableColumn<SeasonEntry>[] = [
  {
    id: "parentTitle",
    header: "Series",
    defaultWidth: 250,
    accessor: (s) => s.parentTitle,
    sortValue: (s) => s.parentTitle,
    sortable: true,
  },
  {
    id: "seasonNumber",
    header: "Season",
    defaultWidth: 110,
    accessor: (s) => s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`,
    sortValue: (s) => s.seasonNumber,
    sortable: true,
  },
  {
    id: "episodeCount",
    header: "Episodes",
    defaultWidth: 90,
    accessor: (s) => s.episodeCount,
    sortValue: (s) => s.episodeCount,
    sortable: true,
    className: "text-right",
    headerClassName: "text-right",
  },
  {
    id: "totalSize",
    header: "Size",
    defaultWidth: 100,
    accessor: (s) => formatFileSize(s.totalSize),
    sortValue: (s) => Number(s.totalSize),
    sortable: true,
    className: "text-right",
    headerClassName: "text-right",
  },
  {
    id: "quality",
    header: "Quality",
    defaultWidth: 200,
    accessor: (s) => <QualityChips chips={qualityChips({ qualityCounts: s.qualityCounts }, "video")} />,
  },
  {
    id: "totalPlayCount",
    header: "Plays",
    defaultWidth: 80,
    accessor: (s) => s.totalPlayCount || "—",
    sortValue: (s) => s.totalPlayCount,
    sortable: true,
    className: "text-right",
    headerClassName: "text-right",
  },
  {
    id: "lastPlayed",
    header: "Last Watched",
    defaultWidth: 120,
    accessor: (s) => formatDate(s.lastPlayed, "—"),
    sortValue: (s) => s.lastPlayed ? new Date(s.lastPlayed).getTime() : 0,
    sortable: true,
  },
  {
    id: "addedAt",
    header: "Added",
    defaultWidth: 100,
    accessor: (s) => formatDate(s.addedAt, "—"),
    sortValue: (s) => s.addedAt ? new Date(s.addedAt).getTime() : 0,
    sortable: true,
  },
];

const SEASONS_FROM = `?from=${encodeURIComponent("/library/series/seasons")}`;

const seasonKeyOf = (s: SeasonEntry) => `${s.seriesKey ?? s.parentTitle}::${s.seasonNumber}`;

// The same popover, with the season's poster as its hero, in both views.
function seasonHover(season: SeasonEntry) {
  return (
    <MediaHoverPopover imageUrl={`/api/media/${season.mediaItemId}/image?type=season`} data={hoverDataFromSeason(season)} />
  );
}

export default function AllSeasonsPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("SERIES_SEASONS");
  const { servers } = useServers();
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode, setViewMode, sortBy, sortOrder, toggleSort, toggleOrder, filters, onFilterChange, clearFilters, hasFilters } =
    useLibraryListState("seasons", "parentTitle");
  const filterPanel = useFilterPanelReset(undefined, clearFilters);
  const { size, setSize, columns } = useCardSize();
  // Guards against a stale slow response landing after a quick filter/sort
  // flip and overwriting state with the wrong items.
  const latest = useLatestRequest();

  const grid = useVirtualPosterGrid({
    count: seasons.length,
    columns,
    aspect: POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/series/seasons", !loading && seasons.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const fetchSeasons = useCallback(async () => {
    const token = latest.begin();
    setLoading(true);
    // Set once this request's list is on screen, from the cache or the server.
    let applied = false;
    try {
      const params = new URLSearchParams();
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      // Through the tab's list cache: a list loaded in the last minute is
      // shown at once, an older one shown and then refreshed behind it.
      await loadCachedList<{ seasons?: SeasonEntry[] }>("/api/media/series/all-seasons", params, (data) => {
        if (!latest.isCurrent(token)) return;
        applied = true;
        setSeasons(data.seasons || []);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch seasons:", error);
      // A failed load with nothing shown for it empties the list, as it did
      // before the cache: the previous list under the new filters would read
      // as their result.
      if (!applied && latest.isCurrent(token)) setSeasons([]);
    } finally {
      if (latest.isCurrent(token)) setLoading(false);
    }
  }, [filters, sortBy, sortOrder, latest]);

  useListFetch(fetchSeasons);

  // Auto-update when real-time sync adds/removes items — no manual refresh.
  useLibrarySyncRefetch({ types: "SERIES" }, fetchSeasons);

  const navigateToSeason = useCallback(
    (season: SeasonEntry) => {
      markChildNavigation();
      router.push(`/library/series/season/${season.mediaItemId}${SEASONS_FROM}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (season: SeasonEntry, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${season.mediaItemId}/image?type=season`}
        title={seasonHoverTitle(season.parentTitle, season.seasonNumber)}
        fallbackIcon="series"
        href={`/library/series/season/${season.mediaItemId}${SEASONS_FROM}`}
        prefetchMediaId={season.mediaItemId}
        onClick={markChildNavigation}
        metadata={
          <MetadataLine stacked>
            {show("metadata", "episodeCount") && <MetadataItem icon={<List />}>{season.episodeCount} {season.episodeCount === 1 ? "ep" : "eps"}</MetadataItem>}
            {show("metadata", "fileSize") && <MetadataItem icon={<HardDrive />}>{formatFileSize(season.totalSize)}</MetadataItem>}
            {show("metadata", "playCount") && season.totalPlayCount > 0 && (
              <MetadataItem icon={<Play />}>{season.totalPlayCount} {season.totalPlayCount === 1 ? "play" : "plays"}</MetadataItem>
            )}
          </MetadataLine>
        }
        qualityBar={qualitySegments(
          qualityChips({ qualityCounts: season.qualityCounts }, "video"),
          getHex,
          (toggle) => show("badges", toggle),
        )}
        servers={serverChips ? season.servers : undefined}
        hoverContent={seasonHover(season)}
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader className="mb-4" title="Series" />

      <LibraryTabs tabs={SERIES_TABS} active="/library/series/seasons" />

      <MediaFilters
        key={filterPanel.panelKey}
        onFilterChange={onFilterChange}
        mediaType="SERIES"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.SERIES_SEASONS}
            onCardDisplayToggle={setVisible}
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
      ) : seasons.length === 0 ? (
        <LibraryEmptyState icon={Tv} noun="seasons" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {seasons.length} {seasons.length === 1 ? "season" : "seasons"}
          </p>

          {viewMode === "table" ? (
            <DataTable<SeasonEntry>
              columns={SEASON_TABLE_COLUMNS}
              data={seasons}
              keyExtractor={seasonKeyOf}
              defaultSortId="parentTitle"
              resizeStorageKey="dt-widths-seasons"
              onRowClick={navigateToSeason}
              renderHoverContent={seasonHover}
            />
          ) : (
            <VirtualCardGrid grid={grid} items={seasons} getKey={seasonKeyOf} renderItem={renderCard} />
          )}
        </>
      )}
    </div>
  );
}
