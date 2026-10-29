"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { Music, ListMusic, Clock, HardDrive } from "lucide-react";
import { LibraryToolbar } from "@/components/library-toolbar";
import type { MediaListItem } from "@/lib/types";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useLibraryList } from "@/hooks/use-library-list";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { useVirtualPosterGrid, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { LibraryEmptyState } from "@/components/library-empty-state";
import { PageHeader } from "@/components/page-header";
import { MediaGridSkeleton } from "@/components/skeletons";
import { MediaHoverPopover, hoverDataFromListItem, hoverSummaryUrl } from "@/components/media-hover-popover";
import { LibraryTabs, MUSIC_TABS } from "@/components/library-tabs";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

const TRACKS_FROM = `?from=${encodeURIComponent("/library/music/tracks")}`;

const trackKey = (track: MediaListItem) => track.id;

// The table's popover carries the track's art as its hero; the card's passes
// the same fields (the card already shows the art).
function trackTableHover(item: MediaListItem) {
  return (
    <MediaHoverPopover
      summaryUrl={hoverSummaryUrl(item.id)}
      imageUrl={`/api/media/${item.id}/image`}
      imageAspect="square"
      data={hoverDataFromListItem(item)}
    />
  );
}

export default function AllTracksPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("MUSIC_TRACKS");
  const { servers } = useServers();
  const { viewMode, setViewMode, sortBy, sortOrder, toggleSort, filters, onFilterChange, clearFilters, hasFilters } =
    useLibraryListState("tracks", "title", { defaultViewMode: "table" });
  const filterPanel = useFilterPanelReset(undefined, clearFilters);
  const { size, setSize, columns } = useCardSize();
  const listParams = new URLSearchParams({
    sortBy,
    sortOrder,
    ...filters,
  });
  const { items, loading, loadingRest } = useLibraryList<MediaListItem>({
    url: "/api/media/music",
    params: listParams,
    mode: "progressive",
    syncScope: { types: "MUSIC" },
  });

  const grid = useVirtualPosterGrid({
    count: items.length,
    columns,
    aspect: SQUARE_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    layoutKey: `${viewMode}:${loading}`,
  });

  const { markChildNavigation } = useScrollRestoration("/library/music/tracks", !loadingRest && items.length > 0, undefined, undefined, {
    getFirstVisibleIndex: grid.getFirstVisibleIndex,
    scrollToIndex: grid.scrollToIndex,
  });

  const openTrack = useCallback(
    (item: MediaListItem) => {
      markChildNavigation();
      router.push(`/library/music/track/${item.id}${TRACKS_FROM}`);
    },
    [markChildNavigation, router],
  );

  const serverChips = showServers && servers.length > 1;
  const renderCard = useCallback(
    (track: MediaListItem, { priority }: GridCardContext) => (
      <MediaCard
        priority={priority}
        imageUrl={`/api/media/${track.id}/image`}
        title={track.title}
        aspectRatio="square"
        fallbackIcon="music"
        href={`/library/music/track/${track.id}${TRACKS_FROM}`}
        prefetchMediaId={track.id}
        onClick={markChildNavigation}
        qualityBar={qualitySegments(qualityChips(track, "music"), getHex, (toggle) => show("badges", toggle))}
        hoverContent={<MediaHoverPopover summaryUrl={hoverSummaryUrl(track.id)} data={hoverDataFromListItem(track)} />}
        servers={serverChips ? track.servers : undefined}
        metadata={
          <MetadataLine stacked>
            {track.parentTitle && <MetadataItem icon={<Music />}>{track.parentTitle}</MetadataItem>}
            {show("metadata", "duration") && track.duration && <MetadataItem icon={<Clock />}>{formatDuration(track.duration)}</MetadataItem>}
            {show("metadata", "fileSize") && track.fileSize && <MetadataItem icon={<HardDrive />}>{formatFileSize(track.fileSize)}</MetadataItem>}
          </MetadataLine>
        }
      />
    ),
    [show, getHex, serverChips, markChildNavigation],
  );

  return (
    <div className="p-4 sm:p-6 md:pr-12">
      <PageHeader className="mb-4" title="Music" />

      <LibraryTabs tabs={MUSIC_TABS} active="/library/music/tracks" />

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
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.MUSIC_TRACKS}
            onCardDisplayToggle={setVisible}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : items.length === 0 ? (
        <LibraryEmptyState icon={ListMusic} noun="tracks" hasFilters={hasFilters} onClear={filterPanel.clear} />
      ) : viewMode === "table" ? (
        <MediaTable
          items={items}
          onItemClick={openTrack}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={toggleSort}
          mediaType="MUSIC"
          renderHoverContent={trackTableHover}
        />
      ) : (
        <VirtualCardGrid grid={grid} items={items} getKey={trackKey} renderItem={renderCard} />
      )}
    </div>
  );
}
