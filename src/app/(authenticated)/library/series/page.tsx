"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useTransition } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChipColors } from "@/components/chip-color-provider";
import { useRouter } from "next/navigation";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { useServers } from "@/hooks/use-servers";
import { ServerFilter } from "@/components/server-filter";
import { AlphabetFilter } from "@/components/alphabet-filter";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tv, Search, ArrowUpDown, Layers, List, LayoutGrid, TableProperties } from "lucide-react";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import Link from "next/link";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine } from "@/components/metadata-line";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { MediaGridSkeleton } from "@/components/skeletons";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useFilterPersistence } from "@/hooks/use-filter-persistence";
import { useRealtime } from "@/hooks/use-realtime";

interface GroupedSeries {
  parentTitle: string;
  mediaItemId: string;
  episodeCount: number;
  seasonCount: number;
  totalSize: string;
  lastPlayed: string | null;
  addedAt: string | null;
  qualityCounts: Record<string, number>;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

const QUALITY_ORDER = ["4K", "1080P", "720P", "480P", "SD", "Other"];

const SORT_OPTIONS = [
  { value: "parentTitle", label: "Name" },
  { value: "seasonCount", label: "Seasons" },
  { value: "episodeCount", label: "Episodes" },
  { value: "totalSize", label: "Size" },
  { value: "lastPlayed", label: "Last Watched" },
  { value: "addedAt", label: "Date Added" },
];

function seriesTableColumns(getSolidStyle: (category: "resolution" | "dynamicRange" | "audioProfile", value: string) => React.CSSProperties): DataTableColumn<GroupedSeries>[] {
  return [
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
        <div className="flex flex-wrap gap-1">
          {QUALITY_ORDER.filter((q) => s.qualityCounts[q]).map((quality) => (
            <Badge
              key={quality}
              className="text-[10px] px-1.5 py-0"
              style={getSolidStyle("resolution", quality)}
            >
              {quality}: {s.qualityCounts[quality]}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "lastPlayed",
      header: "Last Watched",
      defaultWidth: 120,
      accessor: (s) => s.lastPlayed ? new Date(s.lastPlayed).toLocaleDateString() : "Never",
      sortValue: (s) => s.lastPlayed ? new Date(s.lastPlayed).getTime() : 0,
      className: "text-muted-foreground",
    },
    {
      id: "addedAt",
      header: "Added",
      defaultWidth: 100,
      accessor: (s) => s.addedAt ? new Date(s.addedAt).toLocaleDateString() : "-",
      sortValue: (s) => s.addedAt ? new Date(s.addedAt).getTime() : 0,
      className: "text-muted-foreground",
    },
  ];
}

function applyFiltersToGroupedSeries(
  seriesList: GroupedSeries[],
  filters: Record<string, string>
): GroupedSeries[] {
  if (Object.keys(filters).length === 0) return seriesList;

  return seriesList.filter((series) => {
    if (filters.resolution) {
      const allowed = filters.resolution.split("|");
      const hasMatch = allowed.some((r) => series.qualityCounts[r] > 0);
      if (!hasMatch) return false;
    }

    if (filters.lastPlayedAtDays) {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(filters.lastPlayedAtDays));
      if (!series.lastPlayed || new Date(series.lastPlayed) < daysAgo) return false;
    }
    if (filters.lastPlayedAtMin) {
      if (!series.lastPlayed || new Date(series.lastPlayed) < new Date(filters.lastPlayedAtMin)) return false;
    }
    if (filters.lastPlayedAtMax) {
      if (!series.lastPlayed || new Date(series.lastPlayed) > new Date(filters.lastPlayedAtMax)) return false;
    }

    if (filters.addedAtDays) {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(filters.addedAtDays));
      if (!series.addedAt || new Date(series.addedAt) < daysAgo) return false;
    }
    if (filters.addedAtMin) {
      if (!series.addedAt || new Date(series.addedAt) < new Date(filters.addedAtMin)) return false;
    }
    if (filters.addedAtMax) {
      if (!series.addedAt || new Date(series.addedAt) > new Date(filters.addedAtMax)) return false;
    }

    if (filters.search) {
      if (!series.parentTitle.toLowerCase().includes(filters.search.toLowerCase())) return false;
    }

    return true;
  });
}

const GAP = 16;

export default function SeriesPage() {
  const router = useRouter();
  const { getSolidStyle } = useChipColors();
  const { show, showServers, setVisible, prefs } = useCardDisplay("SERIES");
  const [seriesList, setSeriesList] = useState<GroupedSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { savedFilters, persistFilters } = useFilterPersistence("filters-/library/series");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [, startTransition] = useTransition();

  const [sortBy, setSortBy] = useState("parentTitle");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const { size, setSize, columns: actualColumns } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();

  const gridContainerRef = useRef<HTMLDivElement>(null);

  const { markChildNavigation } = useScrollRestoration("/library/series", !loading && seriesList.length > 0, undefined, undefined, {
    getFirstVisibleIndex: () => {
      if (!gridContainerRef.current) return -1;
      const main = document.querySelector<HTMLElement>("main");
      if (!main) return -1;
      const containerWidth = gridContainerRef.current.offsetWidth;
      const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
      const rowHeight = Math.round(columnWidth * 1.5 + 80 + GAP);
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
      const rowHeight = Math.round(columnWidth * 1.5 + 80 + GAP);
      const gridTop = gridContainerRef.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      main.scrollTop = Math.max(0, gridTop + row * rowHeight + rowHeight / 2 - main.clientHeight / 2);
      return true;
    },
  });

  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

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

  useEffect(() => {
    const stored = localStorage.getItem("series-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("series-view-mode", mode);
  };

  const fetchSeries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      params.set("limit", "0");
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      const response = await fetch(`/api/media/series/grouped?${params}`);
      const data = await response.json();
      startTransition(() => {
        setSeriesList(data.series || []);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch series:", error);
      setLoading(false);
    }
  }, [search, sortBy, sortOrder, selectedServerId]);

  useRealtime("sync:completed", fetchSeries);

  useEffect(() => {
    const timeout = setTimeout(() => fetchSeries(), 300);
    return () => clearTimeout(timeout);
  }, [fetchSeries]);

  const filteredSeries = useMemo(
    () => applyFiltersToGroupedSeries(seriesList, filters),
    [seriesList, filters]
  );

  const rowCount = useMemo(
    () => (filteredSeries.length > 0 ? Math.ceil(filteredSeries.length / actualColumns) : 0),
    [filteredSeries.length, actualColumns]
  );

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
  useEffect(() => {
    virtualizer.measure();
  }, [actualColumns, virtualizer]);

  const alphabetItems = useMemo(
    () => filteredSeries.map((s) => ({ title: s.parentTitle })),
    [filteredSeries]
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

  const handleLetterClick = useCallback((letter: string) => {
    if (viewMode === "cards") {
      gridAlphabet.scrollToLetter(letter);
    } else {
      tableAlphabet.scrollToLetter(letter);
    }
  }, [viewMode, gridAlphabet, tableAlphabet]);

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  return (
    <div className="p-4 sm:p-6 md:pr-12">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold">Series</h1>
        {!loading && filteredSeries.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{filteredSeries.length.toLocaleString()} series</span>
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{filteredSeries.reduce((sum, s) => sum + s.seasonCount, 0).toLocaleString()} seasons</span>
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{filteredSeries.reduce((sum, s) => sum + s.episodeCount, 0).toLocaleString()} episodes</span>
          </div>
        )}
        <SyncLibraryButton libraryType="SERIES" onSyncComplete={fetchSeries} />
      </div>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/series"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
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
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <List className="h-4 w-4" />
          All Episodes
        </Link>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border p-1">
            <button
              onClick={() => handleViewModeChange("cards")}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                viewMode === "cards"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
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
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
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
              <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.SERIES} onToggle={setVisible} />
            </>
          )}
        </div>

        <ServerFilter
          servers={servers}
          value={selectedServerId}
          onChange={setSelectedServerId}
        />

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search series..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
          <Select value={sortBy} onValueChange={(v) => toggleSort(v)}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
            }
            title={sortOrder === "asc" ? "Ascending" : "Descending"}
          >
            <span className="text-xs font-medium">
              {sortOrder === "asc" ? "A-Z" : "Z-A"}
            </span>
          </Button>
        </div>
      </div>

      <MediaFilters
        onFilterChange={(f) => { setFilters(f); persistFilters(f); }}
        externalFilters={Object.keys(savedFilters).length > 0 ? savedFilters : undefined}
        mediaType="SERIES"
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : filteredSeries.length === 0 ? (
        <EmptyState
          icon={Tv}
          title="No series found."
          description={Object.keys(filters).length > 0 ? "Try adjusting your filters." : "Sync a media server to get started."}
          action={Object.keys(filters).length > 0 ? <Button variant="outline" size="sm" onClick={() => { setFilters({}); persistFilters({}); }}>Clear Filters</Button> : undefined}
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {filteredSeries.length} series
          </p>

          {viewMode === "table" ? (
            <DataTable<GroupedSeries>
              columns={seriesTableColumns(getSolidStyle)}
              data={filteredSeries}
              keyExtractor={(s) => s.parentTitle}
              defaultSortId="parentTitle"
              resizeStorageKey="dt-widths-series"
              onRowClick={(s) => { markChildNavigation(); router.push(`/library/series/show/${s.mediaItemId}`); }}
              scrollToIndexRef={tableScrollToIndexRef}
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
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const rowStart = virtualRow.index * actualColumns;
                  const rowItems = filteredSeries.slice(rowStart, rowStart + actualColumns);
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
                        {rowItems.map((s) => (
                          <MediaCard
                            key={s.parentTitle}
                            imageUrl={`/api/media/${s.mediaItemId}/image?type=parent`}
                            title={s.parentTitle}
                            fallbackIcon="series"
                            onClick={() => { markChildNavigation(); router.push(`/library/series/show/${s.mediaItemId}`); }}
                            metadata={
                              <MetadataLine>
                                {show("metadata", "seasonCount") && s.seasonCount > 0 && (
                                  <span>{s.seasonCount} {s.seasonCount === 1 ? "season" : "seasons"}</span>
                                )}
                                {show("metadata", "episodeCount") && <span>{s.episodeCount} ep</span>}
                                {show("metadata", "fileSize") && <span>{formatFileSize(s.totalSize)}</span>}
                              </MetadataLine>
                            }
                            badges={
                              <>
                                {show("badges", "qualityCounts") && QUALITY_ORDER.filter(
                                  (q) => s.qualityCounts[q],
                                ).map((quality) => (
                                  <Badge
                                    key={quality}
                                    className="text-[10px] px-1.5 py-0"
                                    style={getSolidStyle("resolution", quality)}
                                  >
                                    {quality}: {s.qualityCounts[quality]}
                                  </Badge>
                                ))}
                              </>
                            }
                            servers={showServers && servers.length > 1 ? s.servers : undefined}
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

      <AlphabetFilter activeLetter={activeLetter} onLetterClick={handleLetterClick} availableLetters={availableLetters} />
    </div>
  );
}
