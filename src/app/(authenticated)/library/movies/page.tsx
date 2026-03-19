"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { cn } from "@/lib/utils";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Film, LayoutGrid, TableProperties } from "lucide-react";
import { MediaGridSkeleton } from "@/components/skeletons";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine } from "@/components/metadata-line";
import { ServerFilter } from "@/components/server-filter";
import { AlphabetFilter } from "@/components/alphabet-filter";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";
import type { MediaItemWithRelations } from "@/lib/types";
import { formatFileSize, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useFilterPersistence } from "@/hooks/use-filter-persistence";
import { useRealtime } from "@/hooks/use-realtime";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

const GAP = 16; // 1rem grid gap

export default function MoviesPage() {
  const router = useRouter();
  const [items, setItems] = useState<MediaItemWithRelations[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { savedFilters, persistFilters } = useFilterPersistence("filters-/library/movies");
  const [sortBy, setSortBy] = useState("title");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const { size, setSize, columns: actualColumns } = useCardSize();
  const [, startTransition] = useTransition();
  const { servers, selectedServerId, setSelectedServerId } = useServers();
  const { getSolidStyle } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("MOVIE");

  const gridContainerRef = useRef<HTMLDivElement>(null);

  const { markChildNavigation } = useScrollRestoration("/library/movies", !loading && items.length > 0, undefined, undefined, {
    getFirstVisibleIndex: () => {
      if (!gridContainerRef.current) return -1;
      const main = document.querySelector<HTMLElement>("main");
      if (!main) return -1;
      // Compute row height from the same formula as estimateSize
      const containerWidth = gridContainerRef.current.offsetWidth;
      const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
      const rowHeight = Math.round(columnWidth * 1.5 + 80 + GAP);
      if (rowHeight <= 0) return -1;
      // Use getBoundingClientRect for reliable grid offset (offsetTop depends on offsetParent chain)
      const gridTop = gridContainerRef.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      // Find the row at the center of the viewport
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
      const rowHeight = Math.round(columnWidth * 1.5 + 80 + GAP);
      // Use getBoundingClientRect for reliable grid offset
      const gridTop = gridContainerRef.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      main.scrollTop = Math.max(0, gridTop + row * rowHeight + rowHeight / 2 - main.clientHeight / 2);
      return true;
    },
  });

  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Find the <main> scroll container on mount
  useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    scrollElementRef.current = main;
    setScrollElement(main);
  }, []);

  useLayoutEffect(() => {
    if (gridContainerRef.current) {
      setScrollMargin(gridContainerRef.current.offsetTop);
    }
  }, []);

  // Compute row count for virtualizer
  const rowCount = useMemo(
    () => (items.length > 0 ? Math.ceil(items.length / actualColumns) : 0),
    [items.length, actualColumns],
  );

  // Estimate row height: poster (1.5:1 aspect) + ~80px text/chips + gap between rows
  const estimateSize = useCallback(() => {
    const container = gridContainerRef.current;
    if (!container) return 350;
    const containerWidth = container.offsetWidth;
    const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * 1.5;
    return Math.round(posterHeight + 80 + GAP);
  }, [actualColumns]);

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
  }, [actualColumns, virtualizer]);

  const alphabetItems = useMemo(
    () => items.map((m) => ({ title: m.titleSort || m.title })),
    [items],
  );

  const gridAlphabet = useVirtualGridAlphabet({
    items: alphabetItems,
    columns: actualColumns,
    virtualizer,
    scrollElement,
    enabled: viewMode === "cards",
  });

  const tableScrollToIndexRef = useRef<((index: number) => void) | null>(null);

  const tableAlphabet = useTableAlphabet({
    items: alphabetItems,
    enabled: viewMode === "table",
    scrollToIndexRef: tableScrollToIndexRef,
  });

  const activeLetter = viewMode === "cards" ? gridAlphabet.activeLetter : tableAlphabet.activeLetter;
  const availableLetters = viewMode === "cards" ? gridAlphabet.availableLetters : tableAlphabet.availableLetters;

  useEffect(() => {
    const stored = localStorage.getItem("movies-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("movies-view-mode", mode);
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
    [sortBy],
  );

  const fetchMovies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "0",
        sortBy,
        sortOrder,
        ...filters,
      });
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }

      const response = await fetch(`/api/media/movies?${params}`);
      const data = await response.json();
      startTransition(() => {
        setItems(data.items);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch movies:", error);
      setLoading(false);
    }
  }, [filters, sortBy, sortOrder, selectedServerId]);

  useRealtime("sync:completed", fetchMovies);

  useEffect(() => {
    const timeout = setTimeout(fetchMovies, 0);
    return () => clearTimeout(timeout);
  }, [fetchMovies]);

  const handleLetterClick = useCallback((letter: string) => {
    if (viewMode === "cards") {
      gridAlphabet.scrollToLetter(letter);
    } else {
      tableAlphabet.scrollToLetter(letter);
    }
  }, [viewMode, gridAlphabet, tableAlphabet]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="p-4 sm:p-6 md:pr-12">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold">Movies</h1>
        {!loading && items.length > 0 && (
          <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{items.length.toLocaleString()}</span>
        )}
        <SyncLibraryButton libraryType="MOVIE" onSyncComplete={fetchMovies} />
      </div>

      <MediaFilters
        onFilterChange={(f) => { setFilters(f); persistFilters(f); }}
        externalFilters={Object.keys(savedFilters).length > 0 ? savedFilters : undefined}
        prefix={
          <div className="flex items-center gap-3">
            <ServerFilter
              servers={servers}
              value={selectedServerId}
              onChange={setSelectedServerId}
            />
            <div className="flex items-center gap-1 rounded-lg border p-1">
              <button
                onClick={() => handleViewModeChange("cards")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "cards"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                title="Card view"
                aria-label="Card view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleViewModeChange("table")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "table"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                title="Table view"
                aria-label="Table view"
              >
                <TableProperties className="h-4 w-4" />
              </button>
            </div>
            {viewMode === "cards" && (
              <>
                <CardSizeControl size={size} onChange={setSize} />
                <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.MOVIE} onToggle={setVisible} />
              </>
            )}
          </div>
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Film}
          title="No movies found."
          description={Object.keys(filters).length > 0 ? "Try adjusting your filters." : "Sync a media server to get started."}
          action={Object.keys(filters).length > 0 ? <Button variant="outline" size="sm" onClick={() => { setFilters({}); persistFilters({}); }}>Clear Filters</Button> : undefined}
        />
      ) : (
        <>
          {viewMode === "table" ? (
            <MediaTable
              items={items}
              onItemClick={(item) => { markChildNavigation(); router.push(`/library/movies/${item.id}`); }}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="MOVIE"
              scrollToIndexRef={tableScrollToIndexRef}
              hideServers={servers.length <= 1}
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
                      <div
                        style={{
                          display: "grid",
                          gap: `${GAP}px`,
                          gridTemplateColumns: `repeat(${actualColumns}, minmax(0, 1fr))`,
                        }}
                      >
                        {rowItems.map((movie) => (
                          <MediaCard
                            key={movie.id}
                            imageUrl={`/api/media/${movie.id}/image`}
                            title={movie.title}
                            fallbackIcon="movie"
                            onClick={() => { markChildNavigation(); router.push(`/library/movies/${movie.id}`); }}
                            metadata={
                              <MetadataLine>
                                {show("metadata", "year") && movie.year && <span>{movie.year}</span>}
                                {show("metadata", "duration") && formatDuration(movie.duration) && <span>{formatDuration(movie.duration)}</span>}
                                {show("metadata", "fileSize") && formatFileSize(movie.fileSize) && <span>{formatFileSize(movie.fileSize)}</span>}
                              </MetadataLine>
                            }
                            badges={
                              <>
                                {show("badges", "resolution") && movie.resolution && (
                                  <Badge
                                    className="text-[10px] px-1.5 py-0"
                                    style={getSolidStyle("resolution", formatResolution(movie.resolution))}
                                  >
                                    {formatResolution(movie.resolution)}
                                  </Badge>
                                )}
                                {show("badges", "dynamicRange") && movie.dynamicRange && movie.dynamicRange !== "SDR" && (
                                  <Badge
                                    className="text-[10px] px-1.5 py-0"
                                    style={getSolidStyle("dynamicRange", movie.dynamicRange)}
                                  >
                                    {movie.dynamicRange}
                                  </Badge>
                                )}
                              </>
                            }
                            servers={showServers && servers.length > 1 ? movie.servers : undefined}
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

      <AlphabetFilter
        activeLetter={activeLetter}
        onLetterClick={handleLetterClick}
        availableLetters={availableLetters}
      />

    </div>
  );
}
