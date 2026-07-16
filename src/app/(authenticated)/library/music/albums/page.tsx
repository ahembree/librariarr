"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MediaCard , CARD_CONTENT_HEIGHT } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { AUDIO_CODEC_ORDER, getChipBadgeStyle } from "@/lib/theme/chip-colors";
import { ColorChip } from "@/components/color-chip";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { MediaFilters } from "@/components/media-filters";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Music, Disc3, ListMusic, HardDrive } from "lucide-react";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useServers } from "@/hooks/use-servers";
import { useRealtime } from "@/hooks/use-realtime";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";
import { LibraryTabs, MUSIC_TABS } from "@/components/library-tabs";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

const GAP = 16;
const CARD_BORDER = 2;
const QUALITY_BAR_HEIGHT = 12;

interface AlbumEntry {
  albumTitle: string;
  artistName: string;
  trackCount: number;
  totalSize: string;
  audioCodecCounts: Record<string, number>;
  mediaItemId: string;
  totalPlayCount: number;
  lastPlayed: string | null;
  addedAt: string | null;
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
  { value: "albumTitle", label: "Name" },
  { value: "artistName", label: "Artist" },
  { value: "trackCount", label: "Tracks" },
  { value: "totalSize", label: "Size" },
];

function albumTableColumns(getHex: (category: "audioCodec", value: string) => string): DataTableColumn<AlbumEntry>[] {
  return [
    {
      id: "albumTitle",
      header: "Album",
      defaultWidth: 250,
      accessor: (a) => <span className="font-medium">{a.albumTitle}</span>,
      sortValue: (a) => a.albumTitle,
      className: "max-w-[300px] truncate",
    },
    {
      id: "artistName",
      header: "Artist",
      defaultWidth: 200,
      accessor: (a) => a.artistName,
      sortValue: (a) => a.artistName,
      className: "text-muted-foreground max-w-[200px] truncate",
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
            <ColorChip key={codec} style={getChipBadgeStyle(getHex("audioCodec", String(codec)))}>
              {codec}: {count}
            </ColorChip>
          ))}
        </div>
      ),
    },
  ];
}

export default function AllAlbumsPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("albumTitle");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("albums-view-mode") as "cards" | "table" | null;
      if (stored) setViewMode(stored);
    } catch { /* private mode / quota — keep default */ }
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    try {
      localStorage.setItem("albums-view-mode", mode);
    } catch { /* private mode / quota — ignore */ }
  };

  const { size, setSize, columns: actualColumns } = useCardSize();
  const { showServers, prefs: cardDisplayPrefs, setVisible: setCardDisplayVisible } = useCardDisplay("MUSIC_ALBUMS");
  const { servers, selectedServerId, setSelectedServerId } = useServers();

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const { markChildNavigation } = useScrollRestoration("/library/music/albums", !loading && albums.length > 0, undefined, undefined, {
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
    scrollElementRef.current = document.querySelector<HTMLElement>("main");
  }, []);

  // Re-measure once the grid mounts behind the loading skeleton (the ref is
  // null on the first pass), so the virtualized rows aren't mis-positioned.
  useLayoutEffect(() => {
    if (gridContainerRef.current) {
      setScrollMargin(gridContainerRef.current.offsetTop);
    }
  }, [loading, albums.length]);

  // Token guards against a stale slow response landing after a quick
  // sort/filter/server flip and showing the wrong items for the selection.
  const reqToken = useRef(0);

  const fetchAlbums = useCallback(async () => {
    const token = ++reqToken.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "0");
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      if (selectedServerId !== "all") {
        params.set("serverId", selectedServerId);
      }
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const response = await fetch(`/api/media/music/albums/all?${params}`);
      const data = await response.json();
      if (token !== reqToken.current) return;
      setAlbums(data.albums || []);
    } catch (error) {
      console.error("Failed to fetch albums:", error);
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [filters, sortBy, sortOrder, selectedServerId]);

  useEffect(() => {
    const timeout = setTimeout(() => fetchAlbums(), 300);
    return () => clearTimeout(timeout);
  }, [fetchAlbums]);

  // Auto-update when real-time sync adds/removes items — no manual refresh.
  useRealtime("sync:completed", fetchAlbums);

  const rowCount = useMemo(
    () => (albums.length > 0 ? Math.ceil(albums.length / actualColumns) : 0),
    [albums.length, actualColumns]
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

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight mb-4">
        Music
      </h1>

      <LibraryTabs tabs={MUSIC_TABS} active="/library/music/albums" />

      <MediaFilters
        onFilterChange={setFilters}
        mediaType="MUSIC"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={cardDisplayPrefs}
            cardDisplayConfig={TOGGLE_CONFIGS.MUSIC_ALBUMS}
            onCardDisplayToggle={setCardDisplayVisible}
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
      ) : albums.length === 0 ? (
        <EmptyState icon={Disc3} title="No albums found." />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {albums.length} {albums.length === 1 ? "album" : "albums"}
          </p>

          {viewMode === "table" ? (
            <DataTable<AlbumEntry>
              columns={albumTableColumns(getHex)}
              data={albums}
              keyExtractor={(a) => `${a.artistName}::${a.albumTitle}`}
              defaultSortId="albumTitle"
              resizeStorageKey="dt-widths-albums"
              onRowClick={(a) => { markChildNavigation(); router.push(`/library/music/album/${a.mediaItemId}?from=${encodeURIComponent("/library/music/albums")}`); }}
              renderHoverContent={(album) => (
                <MediaHoverPopover
                  imageUrl={`/api/media/${album.mediaItemId}/image?type=season`}
                  imageAspect="square"
                  data={{
                    title: album.albumTitle,
                    year: album.year,
                    summary: album.summary,
                    contentRating: album.contentRating,
                    rating: album.rating,
                    ratingImage: album.ratingImage,
                    audienceRating: album.audienceRating,
                    audienceRatingImage: album.audienceRatingImage,
                    genres: album.genres,
                    studio: album.studio,
                    trackCount: album.trackCount,
                    audioCodecCounts: album.audioCodecCounts,
                    fileSize: album.totalSize,
                    playCount: album.totalPlayCount,
                    lastPlayedAt: album.lastPlayed,
                    addedAt: album.addedAt,
                    servers: album.servers,
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
                  const rowItems = albums.slice(rowStart, rowStart + actualColumns);
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
                        {rowItems.map((album) => (
                          <MediaCard
                            key={`${album.artistName}::${album.albumTitle}`}
                            imageUrl={`/api/media/${album.mediaItemId}/image?type=season`}
                            title={album.albumTitle}
                            aspectRatio="square"
                            fallbackIcon="music"
                            href={`/library/music/album/${album.mediaItemId}?from=${encodeURIComponent("/library/music/albums")}`}
                            onClick={markChildNavigation}
                            qualityBar={
                              Object.keys(album.audioCodecCounts).length > 0
                                ? [
                                    ...AUDIO_CODEC_ORDER
                                      .filter((c) => album.audioCodecCounts[c])
                                      .map((codec) => ({
                                        color: getHex("audioCodec", codec),
                                        weight: album.audioCodecCounts[codec],
                                        label: `${codec}: ${album.audioCodecCounts[codec]}`,
                                      })),
                                    ...Object.entries(album.audioCodecCounts)
                                      .filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c))
                                      .map(([codec, count]) => ({
                                        color: getHex("audioCodec", codec),
                                        weight: count,
                                        label: `${codec}: ${count}`,
                                      })),
                                  ]
                                : undefined
                            }
                            servers={showServers && servers.length > 1 ? album.servers : undefined}
                            hoverContent={
                              <MediaHoverPopover
                                imageUrl={`/api/media/${album.mediaItemId}/image?type=season`}
                                imageAspect="square"
                                data={{
                                  // Keep the field set identical to the table
                                  // view's popover (style-guide convention).
                                  title: album.albumTitle,
                                  year: album.year,
                                  summary: album.summary,
                                  contentRating: album.contentRating,
                                  rating: album.rating,
                                  ratingImage: album.ratingImage,
                                  audienceRating: album.audienceRating,
                                  audienceRatingImage: album.audienceRatingImage,
                                  genres: album.genres,
                                  studio: album.studio,
                                  trackCount: album.trackCount,
                                  audioCodecCounts: album.audioCodecCounts,
                                  fileSize: album.totalSize,
                                  playCount: album.totalPlayCount,
                                  lastPlayedAt: album.lastPlayed,
                                  addedAt: album.addedAt,
                                  servers: album.servers,
                                }}
                              />
                            }
                            metadata={
                              <MetadataLine stacked>
                                <MetadataItem icon={<Music />}>
                                  {album.artistName}
                                </MetadataItem>
                                <MetadataItem icon={<ListMusic />}>
                                  {album.trackCount}{" "}
                                  {album.trackCount === 1 ? "track" : "tracks"}
                                </MetadataItem>
                                <MetadataItem icon={<HardDrive />}>
                                  {formatFileSize(album.totalSize)}
                                </MetadataItem>
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
        </>
      )}
    </div>
  );
}
