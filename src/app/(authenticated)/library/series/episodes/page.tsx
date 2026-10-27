"use client";

import { useState, useCallback, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { useChipColors } from "@/components/chip-color-provider";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { Tv, Clock, HardDrive } from "lucide-react";
import { LibraryToolbar } from "@/components/library-toolbar";
import type { MediaListItem } from "@/lib/types";
import { useCardSize, BREAKPOINTS, estimateContentWidth } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useListFetch } from "@/hooks/use-list-fetch";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { useVirtualPosterGrid, GRID_GAP, WIDE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { fetchListProgressively } from "@/lib/media/progressive-load";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { formatEpisodeCode, formatEpisodeTitle } from "@/lib/media/display-title";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { MediaGridSkeleton } from "@/components/skeletons";
import { MediaHoverPopover, hoverDataFromListItem, hoverSummaryUrl } from "@/components/media-hover-popover";
import { LibraryTabs, SERIES_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

// Landscape card min widths (matches useCardSize internals)
const LANDSCAPE_MIN_WIDTHS: Record<string, number> = { small: 140, medium: 200, large: 260 };
const MOBILE_LANDSCAPE_MIN_WIDTHS: Record<string, number> = { small: 110, medium: 140, large: 200 };

const EPISODES_FROM = `?from=${encodeURIComponent("/library/series/episodes")}`;

const episodeKey = (ep: MediaListItem) => ep.id;

// The table's popover carries the show's poster as its hero; the card's passes
// the same fields (the card already shows the still).
function episodeTableHover(item: MediaListItem) {
  return (
    <MediaHoverPopover
      summaryUrl={hoverSummaryUrl(item.id)}
      imageUrl={`/api/media/${item.id}/image?type=parent`}
      data={hoverDataFromListItem(item, { title: formatEpisodeTitle(item) })}
    />
  );
}

export default function AllEpisodesPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("SERIES_EPISODES");
  const { servers } = useServers();
  const [items, setItems] = useState<MediaListItem[]>([]);
  // Cards are headed "<Show> SxxExx", so they list by show, then SxxExx.
  const { viewMode, setViewMode, sortBy, sortOrder, toggleSort, filters, onFilterChange, clearFilters, hasFilters } =
    useLibraryListState("episodes", "parentTitle", { defaultViewMode: "table" });
  const filterPanel = useFilterPanelReset(undefined, clearFilters);
  const [loading, setLoading] = useState(true);
  // The first screenful arrives before the rest of the library; consumers that
  // need the complete list (item count, scroll restoration) wait for this.
  const [loadingRest, setLoadingRest] = useState(true);
  const [, startTransition] = useTransition();
  const { size, setSize, columns: actualColumns } = useCardSize();
  // Guards against a stale slow response landing after a quick filter/sort
  // flip and overwriting state with the wrong items.
  const latest = useLatestRequest();

  // Compute landscape column count from screen width and landscape min widths
  const landscapeColumns = useMemo(() => {
    const screenWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
    const isMobile = screenWidth < BREAKPOINTS.md;
    const minWidth = isMobile ? MOBILE_LANDSCAPE_MIN_WIDTHS[size] : LANDSCAPE_MIN_WIDTHS[size];
    const contentWidth = estimateContentWidth(screenWidth);
    return Math.max(2, Math.floor((contentWidth + GRID_GAP) / (minWidth + GRID_GAP)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, actualColumns]); // actualColumns changes on resize, so we recompute

  const grid = useVirtualPosterGrid({
    count: items.length,
    columns: landscapeColumns,
    aspect: WIDE_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/series/episodes", !loadingRest && items.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const fetchEpisodes = useCallback(async () => {
    const token = latest.begin();
    setLoading(true);
    setLoadingRest(true);
    try {
      const params = new URLSearchParams({
        sortBy,
        sortOrder,
        ...filters,
      });
      // Paint the first screenful, then fill in the rest behind it — the whole
      // library in one response meant nothing rendered until all of it landed.
      let firstChunk = true;
      await fetchListProgressively<MediaListItem>(
        "/api/media/series",
        params,
        (loaded, done) => {
          if (!latest.isCurrent(token)) return;
          const apply = () => {
            setItems(loaded);
            setLoading(false);
            if (done) setLoadingRest(false);
          };
          // First screenful as a normal update (a transition only delayed it);
          // the rest of the library stays a transition.
          if (firstChunk) apply();
          else startTransition(apply);
          firstChunk = false;
        },
      );
    } catch (error) {
      console.error("Failed to fetch episodes:", error);
      if (latest.isCurrent(token)) {
        setLoading(false);
        setLoadingRest(false);
      }
    }
  }, [filters, sortBy, sortOrder, latest]);

  useListFetch(fetchEpisodes);

  // Auto-update when real-time sync adds/removes items — no manual refresh.
  useLibrarySyncRefetch({ types: "SERIES" }, fetchEpisodes);

  const openEpisode = useCallback(
    (item: MediaListItem) => {
      markChildNavigation();
      router.push(`/library/series/episode/${item.id}${EPISODES_FROM}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (ep: MediaListItem, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${ep.id}/image`}
        title={formatEpisodeTitle(ep)}
        aspectRatio="landscape"
        fallbackIcon="series"
        href={`/library/series/episode/${ep.id}${EPISODES_FROM}`}
        prefetchMediaId={ep.id}
        onClick={markChildNavigation}
        hoverContent={
          <MediaHoverPopover
            summaryUrl={hoverSummaryUrl(ep.id)}
            data={hoverDataFromListItem(ep, { title: formatEpisodeTitle(ep) })}
          />
        }
        metadata={
          <MetadataLine stacked>
            {/* The heading already names the show and SxxExx (or, unnumbered, the episode title). */}
            {show("metadata", "episodeTitle") && ep.title && formatEpisodeCode(ep.seasonNumber, ep.episodeNumber) && (
              <MetadataItem icon={<Tv />}>{ep.title}</MetadataItem>
            )}
            {show("metadata", "duration") && formatDuration(ep.duration) && <MetadataItem icon={<Clock />}>{formatDuration(ep.duration)}</MetadataItem>}
            {show("metadata", "fileSize") && formatFileSize(ep.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(ep.fileSize)}</MetadataItem>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(qualityChips(ep, "video"), getHex, (toggle) => show("badges", toggle))}
        servers={serverChips ? ep.servers : undefined}
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader className="mb-4" title="Series" />

      <LibraryTabs tabs={SERIES_TABS} active="/library/series/episodes" />

      <MediaFilters
        resetKey={filterPanel.resetKey}
        onFilterChange={onFilterChange}
        mediaType="SERIES"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.SERIES_EPISODES}
            onCardDisplayToggle={setVisible}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : items.length === 0 ? (
        <LibraryEmptyState icon={Tv} noun="episodes" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : viewMode === "table" ? (
        <MediaTable
          items={items}
          onItemClick={openEpisode}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={toggleSort}
          mediaType="SERIES"
          renderHoverContent={episodeTableHover}
        />
      ) : (
        <VirtualCardGrid grid={grid} items={items} getKey={episodeKey} renderItem={renderCard} />
      )}
    </div>
  );
}
