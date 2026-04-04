"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { Tv, Layers, List, Clock, HardDrive } from "lucide-react";
import { LibraryToolbar } from "@/components/library-toolbar";
import Link from "next/link";
import type { MediaItemWithRelations } from "@/lib/types";
import { useCardSize, BREAKPOINTS } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";
import { MediaHoverPopover } from "@/components/media-hover-popover";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

const GAP = 16;
const CARD_CONTENT_HEIGHT = 138;
const CARD_BORDER = 2;
const QUALITY_BAR_HEIGHT = 12;

// Landscape card min widths (matches useCardSize internals)
const LANDSCAPE_MIN_WIDTHS: Record<string, number> = { small: 140, medium: 200, large: 260 };
const MOBILE_LANDSCAPE_MIN_WIDTHS: Record<string, number> = { small: 110, medium: 140, large: 200 };

function estimateContentWidth(screenWidth: number): number {
  if (screenWidth >= BREAKPOINTS.xl) return screenWidth - 300;
  if (screenWidth >= BREAKPOINTS.lg) return screenWidth - 100;
  if (screenWidth >= BREAKPOINTS.md) return screenWidth - 80;
  return screenWidth - 48;
}

export default function AllEpisodesPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("SERIES_EPISODES");
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

  // Compute landscape column count from screen width and landscape min widths
  const landscapeColumns = useMemo(() => {
    const screenWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
    const isMobile = screenWidth < BREAKPOINTS.md;
    const minWidth = isMobile ? MOBILE_LANDSCAPE_MIN_WIDTHS[size] : LANDSCAPE_MIN_WIDTHS[size];
    const contentWidth = estimateContentWidth(screenWidth);
    return Math.max(2, Math.floor((contentWidth + GAP) / (minWidth + GAP)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, actualColumns]); // actualColumns changes on resize, so we recompute

  // Find the <main> scroll container on mount
  useEffect(() => {
    scrollElementRef.current = document.querySelector<HTMLElement>("main");
  }, []);

  useLayoutEffect(() => {
    if (gridContainerRef.current) {
      setScrollMargin(gridContainerRef.current.offsetTop);
    }
  }, []);

  // Compute row count for virtualizer
  const rowCount = useMemo(
    () => (items.length > 0 ? Math.ceil(items.length / landscapeColumns) : 0),
    [items.length, landscapeColumns],
  );

  const estimateSize = useCallback(() => {
    const container = gridContainerRef.current;
    if (!container) return 250;
    const containerWidth = container.offsetWidth;
    const columnWidth = (containerWidth - GAP * (landscapeColumns - 1)) / landscapeColumns;
    const posterHeight = columnWidth * 0.5625; // 16:9 landscape aspect ratio
    return Math.round(posterHeight + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
  }, [landscapeColumns]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize,
    overscan: 10,
    scrollMargin,
  });

  // Re-measure when columns change
  useEffect(() => {
    virtualizer.measure();
  }, [landscapeColumns, virtualizer]);

  useEffect(() => {
    const stored = localStorage.getItem("episodes-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("episodes-view-mode", mode);
  };

  const handleSort = useCallback(
    (field: string) => {
      if (field === sortBy) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setSortOrder("asc");
      }
    },
    [sortBy]
  );

  const fetchEpisodes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "0",
        sortBy,
        sortOrder,
        ...filters,
      });

      const response = await fetch(`/api/media/series?${params}`);
      const data = await response.json();
      startTransition(() => {
        setItems(data.items);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch episodes:", error);
      setLoading(false);
    }
  }, [filters, sortBy, sortOrder]);

  useEffect(() => {
    const timeout = setTimeout(fetchEpisodes, 0);
    return () => clearTimeout(timeout);
  }, [fetchEpisodes]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight mb-4">Series</h1>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/series"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Tv className="h-4 w-4" />
          Series
        </Link>
        <Link
          href="/library/series/seasons"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Layers className="h-4 w-4" />
          All Seasons
        </Link>
        <Link
          href="/library/series/episodes"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
        >
          <List className="h-4 w-4" />
          All Episodes
        </Link>
      </nav>

      <MediaFilters
        onFilterChange={setFilters}
        mediaType="SERIES"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
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
        <EmptyState icon={Tv} title="No episodes found." />
      ) : (
        <>
          {viewMode === "table" ? (
            <MediaTable
              items={items}
              onItemClick={(item) => router.push(`/library/series/episode/${item.id}`)}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="SERIES"
              renderHoverContent={(item) => (
                <MediaHoverPopover
                  imageUrl={`/api/media/${item.id}/image?type=parent`}
                  data={{
                    title: item.title,
                    year: item.year,
                    summary: item.summary,
                    contentRating: item.contentRating,
                    rating: item.rating,
                    audienceRating: item.audienceRating,
                    duration: item.duration,
                    resolution: item.resolution,
                    dynamicRange: item.dynamicRange,
                    audioProfile: item.audioProfile,
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
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualRows.map((virtualRow) => {
                  const rowStart = virtualRow.index * landscapeColumns;
                  const rowItems = items.slice(rowStart, rowStart + landscapeColumns);
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        paddingBottom: GAP,
                        transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          gap: `${GAP}px`,
                          gridTemplateColumns: `repeat(${landscapeColumns}, minmax(0, 1fr))`,
                        }}
                      >
                        {rowItems.map((ep) => (
                          <MediaCard
                            key={ep.id}
                            imageUrl={`/api/media/${ep.id}/image`}
                            title={ep.title}
                            aspectRatio="landscape"
                            fallbackIcon="series"
                            onClick={() => router.push(`/library/series/episode/${ep.id}`)}
                            hoverContent={
                              <MediaHoverPopover
                                data={{
                                  title: ep.title,
                                  year: ep.year,
                                  summary: ep.summary,
                                  contentRating: ep.contentRating,
                                  rating: ep.rating,
                                  audienceRating: ep.audienceRating,
                                  duration: ep.duration,
                                  resolution: ep.resolution,
                                  dynamicRange: ep.dynamicRange,
                                  audioProfile: ep.audioProfile,
                                  fileSize: ep.fileSize,
                                  genres: ep.genres,
                                  studio: ep.studio,
                                  playCount: ep.playCount,
                                  lastPlayedAt: ep.lastPlayedAt,
                                  addedAt: ep.addedAt,
                                  servers: ep.servers,
                                }}
                              />
                            }
                            metadata={
                              <MetadataLine stacked>
                                {show("metadata", "seriesName") && ep.parentTitle && <MetadataItem icon={<Tv />}>{ep.parentTitle}</MetadataItem>}
                                {show("metadata", "episodeLabel") && ep.seasonNumber != null && ep.episodeNumber != null && (
                                  <MetadataItem icon={<List />}>S{String(ep.seasonNumber).padStart(2, "0")}E{String(ep.episodeNumber).padStart(2, "0")}</MetadataItem>
                                )}
                                {show("metadata", "duration") && formatDuration(ep.duration) && <MetadataItem icon={<Clock />}>{formatDuration(ep.duration)}</MetadataItem>}
                                {show("metadata", "fileSize") && formatFileSize(ep.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(ep.fileSize)}</MetadataItem>}
                              </MetadataLine>
                            }
                            qualityBar={
                              show("badges", "resolution") || show("badges", "dynamicRange") || show("badges", "audioProfile")
                                ? [
                                    ...(show("badges", "resolution") && ep.resolution
                                      ? [{ color: getHex("resolution", formatResolution(ep.resolution)), weight: 1, label: formatResolution(ep.resolution) }]
                                      : []),
                                    ...(show("badges", "dynamicRange") && ep.dynamicRange && ep.dynamicRange !== "SDR"
                                      ? [{ color: getHex("dynamicRange", ep.dynamicRange), weight: 1, label: ep.dynamicRange }]
                                      : []),
                                    ...(show("badges", "audioProfile") && ep.audioProfile
                                      ? [{ color: getHex("audioProfile", ep.audioProfile), weight: 1, label: ep.audioProfile }]
                                      : []),
                                  ]
                                : undefined
                            }
                            servers={showServers && servers.length > 1 ? ep.servers : undefined}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}
