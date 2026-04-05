"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useTransition } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { AUDIO_CODEC_ORDER, getChipBadgeStyle } from "@/lib/theme/chip-colors";
import Link from "next/link";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { Button } from "@/components/ui/button";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Music, Disc3, ListMusic, HardDrive } from "lucide-react";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { useServers } from "@/hooks/use-servers";
import { AlphabetFilter } from "@/components/alphabet-filter";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { SyncLibraryButton } from "@/components/sync-library-button";
import { MediaGridSkeleton } from "@/components/skeletons";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { useFilterPersistence } from "@/hooks/use-filter-persistence";
import { useRealtime } from "@/hooks/use-realtime";

const GAP = 16;
const CARD_CONTENT_HEIGHT = 138; // Fixed content area below poster (matches h-34.5 in MediaCard)
const CARD_BORDER = 2; // 1px top + 1px bottom border on Card
const QUALITY_BAR_HEIGHT = 12; // h-1 quality bar (4px) + py-1 padding (8px)

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

function artistTableColumns(getHex: (category: "resolution" | "dynamicRange" | "audioProfile" | "audioCodec", value: string) => string): DataTableColumn<GroupedArtist>[] {
  return [
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
        <div className="flex flex-wrap gap-1">
          {[
            ...AUDIO_CODEC_ORDER.filter((c) => a.audioCodecCounts[c]).map((c) => [c, a.audioCodecCounts[c]] as const),
            ...Object.entries(a.audioCodecCounts).filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c)),
          ].map(([codec, count]) => (
              <ColorChip
                key={codec}
                style={getChipBadgeStyle(getHex("audioCodec", String(codec)))}
              >
                {codec}: {count}
              </ColorChip>
            ))}
        </div>
      ),
    },
    {
      id: "lastPlayed",
      header: "Last Played",
      defaultWidth: 120,
      accessor: (a) => a.lastPlayed ? new Date(a.lastPlayed).toLocaleDateString() : "Never",
      sortValue: (a) => a.lastPlayed ? new Date(a.lastPlayed).getTime() : 0,
      className: "text-muted-foreground",
    },
    {
      id: "addedAt",
      header: "Added",
      defaultWidth: 100,
      accessor: (a) => a.addedAt ? new Date(a.addedAt).toLocaleDateString() : "-",
      sortValue: (a) => a.addedAt ? new Date(a.addedAt).getTime() : 0,
      className: "text-muted-foreground",
    },
  ];
}

export default function MusicPage() {
  const router = useRouter();
  const [artistList, setArtistList] = useState<GroupedArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { savedFilters, persistFilters } = useFilterPersistence("filters-/library/music");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [, startTransition] = useTransition();
  const { show, showServers, setVisible, prefs } = useCardDisplay("MUSIC");
  const { getHex } = useChipColors();

  const { size, setSize, columns: actualColumns } = useCardSize();
  const { servers, selectedServerId, setSelectedServerId } = useServers();

  const gridContainerRef = useRef<HTMLDivElement>(null);

  const { markChildNavigation } = useScrollRestoration("/library/music", !loading && artistList.length > 0, undefined, undefined, {
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
    const stored = localStorage.getItem("music-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("music-view-mode", mode);
  };

  const [sortBy, setSortBy] = useState("parentTitle");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  const fetchArtists = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      params.set("limit", "0");
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const response = await fetch(`/api/media/music/grouped?${params}`);
      const data = await response.json();
      startTransition(() => {
        setArtistList(data.artists || []);
        setLoading(false);
      });
    } catch (error) {
      console.error("Failed to fetch artists:", error);
      setLoading(false);
    }
  }, [sortBy, sortOrder, selectedServerId, filters]);

  useRealtime("sync:completed", fetchArtists);

  useEffect(() => {
    const timeout = setTimeout(() => fetchArtists(), 300);
    return () => clearTimeout(timeout);
  }, [fetchArtists]);

  const rowCount = useMemo(
    () => (artistList.length > 0 ? Math.ceil(artistList.length / actualColumns) : 0),
    [artistList.length, actualColumns]
  );

  const estimateSize = useCallback(() => {
    const container = gridContainerRef.current;
    const containerWidth = container?.offsetWidth || estimateContentWidth(window.innerWidth);
    const columnWidth = (containerWidth - GAP * (actualColumns - 1)) / actualColumns;
    const posterHeight = columnWidth * 1.0;
    return Math.round(posterHeight + QUALITY_BAR_HEIGHT + CARD_CONTENT_HEIGHT + CARD_BORDER + GAP);
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
    () => artistList.map((a) => ({ title: a.parentTitle })),
    [artistList]
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
    scrollElement,
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
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Music</h1>
        {!loading && artistList.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{artistList.length.toLocaleString()} artists</span>
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{artistList.reduce((sum, a) => sum + a.albumCount, 0).toLocaleString()} albums</span>
            <span className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{artistList.reduce((sum, a) => sum + a.trackCount, 0).toLocaleString()} songs</span>
          </div>
        )}
        <SyncLibraryButton libraryType="MUSIC" onSyncComplete={fetchArtists} />
      </div>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/music"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
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
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <ListMusic className="h-4 w-4" />
          All Tracks
        </Link>
      </nav>

      <MediaFilters
        onFilterChange={(f) => { setFilters(f); persistFilters(f); }}
        externalFilters={Object.keys(savedFilters).length > 0 ? savedFilters : undefined}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
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
            onSortChange={(v) => toggleSort(v)}
            onSortOrderToggle={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : artistList.length === 0 ? (
        <EmptyState
          icon={Music}
          title="No artists found."
          description={Object.keys(filters).length > 0 ? "Try adjusting your filters." : "Sync a media server to get started."}
          action={Object.keys(filters).length > 0 ? <Button variant="outline" size="sm" onClick={() => { setFilters({}); persistFilters({}); }}>Clear Filters</Button> : undefined}
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {artistList.length} artists
          </p>

          {viewMode === "table" ? (
            <DataTable<GroupedArtist>
              columns={artistTableColumns(getHex)}
              data={artistList}
              keyExtractor={(a) => a.parentTitle}
              defaultSortId="parentTitle"
              resizeStorageKey="dt-widths-music"
              onRowClick={(a) => { markChildNavigation(); router.push(`/library/music/artist/${a.mediaItemId}`); }}
              scrollToIndexRef={tableScrollToIndexRef}
              renderHoverContent={(a) => (
                <MediaHoverPopover
                  imageUrl={`/api/media/${a.mediaItemId}/image?type=parent`}
                  imageAspect="square"
                  data={{
                    title: a.parentTitle,
                    year: a.year,
                    summary: a.summary,
                    contentRating: a.contentRating,
                    rating: a.rating,
                    ratingImage: a.ratingImage,
                    audienceRating: a.audienceRating,
                    audienceRatingImage: a.audienceRatingImage,
                    genres: a.genres,
                    studio: a.studio,
                    albumCount: a.albumCount,
                    trackCount: a.trackCount,
                    audioCodecCounts: a.audioCodecCounts,
                    fileSize: a.totalSize,
                    lastPlayedAt: a.lastPlayed,
                    addedAt: a.addedAt,
                    servers: a.servers,
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
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const rowStart = virtualRow.index * actualColumns;
                  const rowItems = artistList.slice(rowStart, rowStart + actualColumns);
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
                        {rowItems.map((a) => (
                          <MediaCard
                            key={a.parentTitle}
                            imageUrl={`/api/media/${a.mediaItemId}/image?type=parent`}
                            title={a.parentTitle}
                            aspectRatio="square"
                            fallbackIcon="music"
                            onClick={() => { markChildNavigation(); router.push(`/library/music/artist/${a.mediaItemId}`); }}
                            metadata={
                              <MetadataLine stacked>
                                {show("metadata", "albumCount") && <MetadataItem icon={<Disc3 />}>{a.albumCount} {a.albumCount === 1 ? "album" : "albums"}</MetadataItem>}
                                {show("metadata", "trackCount") && <MetadataItem icon={<ListMusic />}>{a.trackCount} tracks</MetadataItem>}
                                {show("metadata", "fileSize") && <MetadataItem icon={<HardDrive />}>{formatFileSize(a.totalSize)}</MetadataItem>}
                              </MetadataLine>
                            }
                            qualityBar={
                              show("badges", "audioCodecs")
                                ? [
                                    ...AUDIO_CODEC_ORDER
                                      .filter((c) => a.audioCodecCounts[c])
                                      .map((codec) => ({
                                        color: getHex("audioCodec", codec),
                                        weight: a.audioCodecCounts[codec],
                                        label: `${codec}: ${a.audioCodecCounts[codec]}`,
                                      })),
                                    ...Object.entries(a.audioCodecCounts)
                                      .filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c))
                                      .map(([codec, count]) => ({
                                        color: getHex("audioCodec", codec),
                                        weight: count,
                                        label: `${codec}: ${count}`,
                                      })),
                                  ]
                                : undefined
                            }
                            servers={showServers && servers.length > 1 ? a.servers : undefined}
                            hoverContent={
                              <MediaHoverPopover
                                data={{
                                  title: a.parentTitle,
                                  year: a.year,
                                  summary: a.summary,
                                  contentRating: a.contentRating,
                                  rating: a.rating,
                                  ratingImage: a.ratingImage,
                                  audienceRating: a.audienceRating,
                                  audienceRatingImage: a.audienceRatingImage,
                                  genres: a.genres,
                                  studio: a.studio,
                                  albumCount: a.albumCount,
                                  trackCount: a.trackCount,
                                  audioCodecCounts: a.audioCodecCounts,
                                  fileSize: a.totalSize,
                                  lastPlayedAt: a.lastPlayed,
                                  addedAt: a.addedAt,
                                  servers: a.servers,
                                }}
                              />
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
        </>
      )}

      <AlphabetFilter activeLetter={activeLetter} onLetterClick={handleLetterClick} availableLetters={availableLetters} />
    </div>
  );
}
