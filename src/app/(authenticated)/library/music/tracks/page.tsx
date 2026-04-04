"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { useChipColors } from "@/components/chip-color-provider";
import { Loader2, Music, Disc3, ListMusic, Clock, HardDrive } from "lucide-react";
import { LibraryToolbar } from "@/components/library-toolbar";
import type { MediaItemWithRelations } from "@/lib/types";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";
import { MediaHoverPopover } from "@/components/media-hover-popover";

export default function AllTracksPage() {
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("MUSIC");
  const [items, setItems] = useState<MediaItemWithRelations[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("title");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { size, setSize, landscapeGridStyle } = useCardSize();

  useEffect(() => {
    const stored = localStorage.getItem("tracks-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("tracks-view-mode", mode);
  };

  const fetchTracks = useCallback(async (pageNum: number, append = false) => {
    if (pageNum === 1) setLoading(true);
    else setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: "50",
        sortBy,
        sortOrder,
        ...filters,
      });
      const response = await fetch(`/api/media/music?${params}`);
      const data = await response.json();
      if (append) {
        setItems((prev) => [...prev, ...data.items]);
      } else {
        setItems(data.items);
      }
      setHasMore(data.pagination?.hasMore ?? false);
    } catch (error) {
      console.error("Failed to fetch tracks:", error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [sortBy, sortOrder, filters]);

  useEffect(() => {
    setPage(1);
    fetchTracks(1);
  }, [fetchTracks]);

  // Infinite scroll
  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          const nextPage = page + 1;
          setPage(nextPage);
          fetchTracks(nextPage, true);
        }
      },
      { rootMargin: "200px" }
    );
    const el = sentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [hasMore, loading, loadingMore, page, fetchTracks]);

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
        onFilterChange={(f) => { setFilters(f); setPage(1); }}
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
          onItemClick={(item) => router.push(`/library/music/track/${item.id}`)}
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
        <>
          <div style={landscapeGridStyle}>
            {items.map((track) => (
              <MediaCard
                key={track.id}
                imageUrl={`/api/media/${track.id}/image`}
                title={track.title}
                aspectRatio="square"
                fallbackIcon="music"
                onClick={() => router.push(`/library/music/track/${track.id}`)}
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
                      duration: track.duration,
                      resolution: track.resolution,
                      dynamicRange: track.dynamicRange,
                      audioProfile: track.audioProfile,
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
          {loadingMore && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          <div ref={sentinelRef} className="h-1" />
        </>
      )}
    </div>
  );
}
