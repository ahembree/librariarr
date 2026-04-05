"use client";

import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { Music, Disc3, ListMusic, Clock, HardDrive } from "lucide-react";
import { LibraryToolbar } from "@/components/library-toolbar";
import type { MediaItemWithRelations } from "@/lib/types";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

const GAP = 16;
const CARD_CONTENT_HEIGHT = 138;
const CARD_BORDER = 2;
const QUALITY_BAR_HEIGHT = 12;

export default function AllTracksPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("MUSIC_TRACKS");
  const { servers } = useServers();
  const [items, setItems] = useState<MediaItemWithRelations[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("title");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const [, startTransition] = useTransition();
  const { size, setSize, columns: actualColumns } = useCardSize();

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const { markChildNavigation } = useScrollRestoration("/library/music/tracks", !loading && items.length > 0, undefined, undefined, {
    getFirstVisibleIndex: () => {
      if (!gridContainerRef.current) return -1;
      const main = document.querySelector<HTMLElement>("main");
      if (!main) return -1;
      const containerWidth = gridContainerRef.current.offsetWidth;
      const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
      const rowHeight = Math.round(columnWidth * 1.0 + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
      if (rowHeight <= 0) return -1;
      const gridTop = gridContainerRef.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const centerInGrid = main.scrollTop + main.clientHeight / 2 - gridTop;
      return Math.max(0, Math.floor(centerInGrid / rowHeight)) * actualColumns;
    },
    scrollToIndex: (index) => {
      if (!gridContainerRef.current) return false;
      const main = document.querySelector<HTMLElement>("main");
      if (!main) return false;
      const row = Math.floor(index / actualColumns);
      const containerWidth = gridContainerRef.current.offsetWidth;
      const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
      const rowHeight = Math.round(columnWidth * 1.0 + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
      const gridTop = gridContainerRef.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      main.scrollTo({ top: Math.max(0, gridTop + row * rowHeight + rowHeight / 2 - main.clientHeight / 2), behavior: "instant" });
      return true;
    },
  });

  useEffect(() => {
    const stored = localStorage.getItem("tracks-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("tracks-view-mode", mode);
  };

  const fetchTracks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "0",
        sortBy,
        sortOrder,
        ...filters,
      });
      const response = await fetch(`/api/media/music?${params}`);
      const data = await response.json();
      startTransition(() => {
        setItems(data.items);
      });
    } catch (error) {
      console.error("Failed to fetch tracks:", error);
    } finally {
      setLoading(false);
    }
  }, [sortBy, sortOrder, filters]);

  useEffect(() => {
    const timeout = setTimeout(fetchTracks, 0);
    return () => clearTimeout(timeout);
  }, [fetchTracks]);

  useEffect(() => {
    scrollElementRef.current = document.querySelector<HTMLElement>("main");
  }, []);

  useLayoutEffect(() => {
    if (gridContainerRef.current) {
      setScrollMargin(gridContainerRef.current.offsetTop);
    }
  }, []);

  const rowCount = useMemo(
    () => Math.ceil(items.length / actualColumns),
    [items.length, actualColumns],
  );

  const estimateSize = useCallback(() => {
    const container = gridContainerRef.current;
    const containerWidth = container?.offsetWidth || estimateContentWidth(window.innerWidth);
    const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * 1.0; // square
    return Math.round(posterHeight + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
  }, [actualColumns]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize,
    scrollMargin,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [actualColumns, virtualizer]);

  const handleSort = useCallback(
    (field: string) => {
      if (field === sortBy) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setSortOrder("asc");
      }
    },
    [sortBy],
  );

  return (
    <div className="p-4 sm:p-6 md:pr-12">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Music</h1>
      </div>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/music"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Music className="h-4 w-4" />
          Artists
        </Link>
        <Link
          href="/library/music/albums"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Disc3 className="h-4 w-4" />
          All Albums
        </Link>
        <Link
          href="/library/music/tracks"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
        >
          <ListMusic className="h-4 w-4" />
          All Tracks
        </Link>
      </nav>

      <MediaFilters
        onFilterChange={setFilters}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
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
        <EmptyState
          icon={ListMusic}
          title="No tracks found."
          description="Try adjusting your filters."
        />
      ) : viewMode === "table" ? (
        <MediaTable
          items={items}
          onItemClick={(item) => { markChildNavigation(); sessionStorage.setItem("library-back-path", "/library/music/tracks"); router.push(`/library/music/track/${item.id}`); }}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={handleSort}
          mediaType="MUSIC"
          renderHoverContent={(item) => (
            <MediaHoverPopover
              imageUrl={`/api/media/${item.id}/image`}
              imageAspect="square"
              data={{
                title: item.title,
                year: item.year,
                summary: item.summary,
                contentRating: item.contentRating,
                rating: item.rating,
                audienceRating: item.audienceRating,
                ratingImage: item.ratingImage,
                audienceRatingImage: item.audienceRatingImage,
                duration: item.duration,
                resolution: item.resolution,
                dynamicRange: item.dynamicRange,
                audioProfile: item.audioProfile,
                audioCodecCounts: item.audioCodec ? { [item.audioCodec.toUpperCase()]: 1 } : undefined,
                fileSize: item.fileSize,
                genres: item.genres,
                studio: item.studio,
                playCount: item.playCount,
                lastPlayedAt: item.lastPlayedAt,
                addedAt: item.addedAt,
                servers: item.servers,
              }}
            />
          )}
        />
      ) : (
        <div ref={gridContainerRef}>
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const rowStart = virtualRow.index * actualColumns;
              const rowItems = items.slice(rowStart, rowStart + actualColumns);
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    paddingBottom: GAP,
                    transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <div style={{ display: "grid", gap: `${GAP}px`, gridTemplateColumns: `repeat(${actualColumns}, minmax(0, 1fr))` }}>
                    {rowItems.map((track) => (
                      <MediaCard
                        key={track.id}
                        imageUrl={`/api/media/${track.id}/image`}
                        title={track.title}
                        aspectRatio="square"
                        fallbackIcon="music"
                        onClick={() => { markChildNavigation(); sessionStorage.setItem("library-back-path", "/library/music/tracks"); router.push(`/library/music/track/${track.id}`); }}
                        qualityBar={
                          track.audioCodec
                            ? [{ color: getHex("audioCodec", track.audioCodec), weight: 1, label: track.audioCodec }]
                            : undefined
                        }
                        hoverContent={
                          <MediaHoverPopover
                            data={{
                              title: track.title,
                              year: track.year,
                              summary: track.summary,
                              contentRating: track.contentRating,
                              rating: track.rating,
                              audienceRating: track.audienceRating,
                              ratingImage: track.ratingImage,
                              audienceRatingImage: track.audienceRatingImage,
                              duration: track.duration,
                              resolution: track.resolution,
                              dynamicRange: track.dynamicRange,
                              audioProfile: track.audioProfile,
                              audioCodecCounts: track.audioCodec ? { [track.audioCodec.toUpperCase()]: 1 } : undefined,
                              fileSize: track.fileSize,
                              genres: track.genres,
                              studio: track.studio,
                              playCount: track.playCount,
                              lastPlayedAt: track.lastPlayedAt,
                              addedAt: track.addedAt,
                              servers: track.servers,
                            }}
                          />
                        }
                        servers={showServers && servers.length > 1 ? track.servers : undefined}
                        metadata={
                          <MetadataLine stacked>
                            {track.parentTitle && <MetadataItem icon={<Music />}>{track.parentTitle}</MetadataItem>}
                            {show("metadata", "duration") && track.duration && <MetadataItem icon={<Clock />}>{formatDuration(track.duration)}</MetadataItem>}
                            {show("metadata", "fileSize") && track.fileSize && <MetadataItem icon={<HardDrive />}>{formatFileSize(track.fileSize)}</MetadataItem>}
                          </MetadataLine>
                        }
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
