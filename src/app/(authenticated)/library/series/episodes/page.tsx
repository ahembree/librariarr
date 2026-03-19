"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { cn } from "@/lib/utils";
import { MediaTable } from "@/components/media-table";
import { MediaFilters } from "@/components/media-filters";
import { MediaCard } from "@/components/media-card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Tv, Layers, List, LayoutGrid, TableProperties } from "lucide-react";
import Link from "next/link";
import type { MediaItemWithRelations } from "@/lib/types";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine } from "@/components/metadata-line";
import { formatFileSize, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

export default function AllEpisodesPage() {
  const router = useRouter();
  const { getSolidStyle } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("SERIES_EPISODES");
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

  const fetchEpisodes = useCallback(
    async (pageNum: number, append: boolean = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const params = new URLSearchParams({
          page: pageNum.toString(),
          limit: "50",
          sortBy,
          sortOrder,
          ...filters,
        });

        const response = await fetch(`/api/media/series?${params}`);
        const data = await response.json();
        if (append) {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            const newItems = data.items.filter(
              (i: MediaItemWithRelations) => !existingIds.has(i.id)
            );
            return [...prev, ...newItems];
          });
        } else {
          setItems(data.items);
        }
        setPage(pageNum);
        setHasMore(data.pagination.hasMore);
      } catch (error) {
        console.error("Failed to fetch episodes:", error);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filters, sortBy, sortOrder]
  );

  // Reset to page 1 when filters/sort change
  useEffect(() => {
    fetchEpisodes(1);
  }, [fetchEpisodes]);

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
          fetchEpisodes(page + 1, true);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, page, fetchEpisodes]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">Series</h1>

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
                <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.SERIES_EPISODES} onToggle={setVisible} />
              </>
            )}
          </div>
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
            />
          ) : (
            <div style={landscapeGridStyle}>
              {items.map((ep) => (
                <MediaCard
                  key={ep.id}
                  imageUrl={`/api/media/${ep.id}/image`}
                  title={ep.title}
                  aspectRatio="landscape"
                  fallbackIcon="series"
                  onClick={() => router.push(`/library/series/episode/${ep.id}`)}
                  metadata={
                    <MetadataLine>
                      {show("metadata", "seriesName") && ep.parentTitle && <span>{ep.parentTitle}</span>}
                      {show("metadata", "episodeLabel") && ep.seasonNumber != null && ep.episodeNumber != null && (
                        <span>S{String(ep.seasonNumber).padStart(2, "0")}E{String(ep.episodeNumber).padStart(2, "0")}</span>
                      )}
                      {show("metadata", "duration") && formatDuration(ep.duration) && <span>{formatDuration(ep.duration)}</span>}
                      {show("metadata", "fileSize") && formatFileSize(ep.fileSize) && <span>{formatFileSize(ep.fileSize)}</span>}
                    </MetadataLine>
                  }
                  badges={
                    <>
                      {show("badges", "resolution") && ep.resolution && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("resolution", formatResolution(ep.resolution))}
                        >
                          {formatResolution(ep.resolution)}
                        </Badge>
                      )}
                      {show("badges", "dynamicRange") && ep.dynamicRange && ep.dynamicRange !== "SDR" && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("dynamicRange", ep.dynamicRange)}
                        >
                          {ep.dynamicRange}
                        </Badge>
                      )}
                      {show("badges", "audioProfile") && ep.audioProfile && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("audioProfile", ep.audioProfile)}
                        >
                          {ep.audioProfile}
                        </Badge>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          )}
          {hasMore && (
            <div ref={sentinelRef} className="mt-4 flex justify-center py-4">
              {loadingMore && (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
        </>
      )}

    </div>
  );
}
