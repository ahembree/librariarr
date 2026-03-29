"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { LayoutGrid, TableProperties, List, Clock, HardDrive } from "lucide-react";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { show, setVisible, prefs } = useCardDisplay("MUSIC_TRACKS");
  const { size, setSize, gridStyle } = useCardSize();
  const [item, setItem] = useState<(MediaItemWithRelations & { albumTitle?: string | null }) | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [tracks, setTracks] = useState<MediaItemWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const [sortBy, setSortBy] = useState("episodeNumber");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    const stored = localStorage.getItem("album-detail-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("album-detail-view-mode", mode);
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

  useEffect(() => {
    async function fetchData() {
      try {
        const itemRes = await fetch(`/api/media/${id}`);
        const itemData = await itemRes.json();
        if (!itemData.item) return;
        setItem(itemData.item);
        setPlayServers(buildPlayLinks(itemData.playServers || [], [
          ["Album", "parentRatingKey"],
          ["Artist", "grandparentRatingKey"],
          ["Track", "ratingKey"],
        ]));

        const artistName = itemData.item.parentTitle;
        const albumTitle = itemData.item.albumTitle;
        if (!artistName || !albumTitle) return;

        const tracksRes = await fetch(
          `/api/media/music?parentTitle=${encodeURIComponent(artistName)}&albumTitle=${encodeURIComponent(albumTitle)}&sortBy=episodeNumber&sortOrder=asc&limit=0`
        );
        const tracksData = await tracksRes.json();
        setTracks(tracksData.items || []);
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  const sortedTracks = useMemo(() => {
    const sorted = [...tracks].sort((a, b) => {
      const aVal = a[sortBy as keyof MediaItemWithRelations];
      const bVal = b[sortBy as keyof MediaItemWithRelations];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal);
      if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
      return String(aVal).localeCompare(String(bVal));
    });
    return sortOrder === "desc" ? sorted.reverse() : sorted;
  }, [tracks, sortBy, sortOrder]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Album not found</p>
      </div>
    );
  }

  const artistName = item.parentTitle || "Unknown Artist";
  const albumTitle = item.albumTitle || item.title;
  const totalSize = tracks.reduce((sum, t) => sum + (t.fileSize ? Number(t.fileSize) : 0), 0);

  // Audio codec breakdown
  const codecCounts: Record<string, number> = {};
  for (const t of tracks) {
    const codec = t.audioCodec ? t.audioCodec.toUpperCase() : "Unknown";
    codecCounts[codec] = (codecCounts[codec] || 0) + 1;
  }

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=season`}
      title={artistName}
      subtitle={
        <>
          <span>{albumTitle}</span>
          <span> &middot; {tracks.length} track{tracks.length !== 1 ? "s" : ""}</span>
        </>
      }
      badges={
        <>
          {Object.entries(codecCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([codec, count]) => (
              <Badge key={codec} variant="outline">
                {codec}: {count}
              </Badge>
            ))}
          {totalSize > 0 && (
            <Badge variant="outline">{formatFileSize(totalSize.toString())}</Badge>
          )}
        </>
      }
      genres={
        item.genres && item.genres.length > 0
          ? item.genres.map((genre) => (
              <Badge key={genre} variant="secondary" className="text-xs bg-white/10 text-white/80 border-white/20">
                {genre}
              </Badge>
            ))
          : undefined
      }
      backHref={`/library/music/artist/${item.id}`}
      backLabel={artistName}
      useParentArt
      posterAspectRatio="1/1"
      playServers={playServers}
    >
      {tracks.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Tracks
            </h2>
            <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
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
                <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.MUSIC_TRACKS} onToggle={setVisible} />
              </>
            )}
          </div>

          {viewMode === "table" ? (
            <MediaTable
              items={sortedTracks}
              onItemClick={(track) => router.push(`/library/music/track/${track.id}`)}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="MUSIC"
              hideParentTitle
            />
          ) : (
            <div style={gridStyle}>
              {sortedTracks.map((t) => (
                <MediaCard
                  key={t.id}
                  imageUrl={`/api/media/${t.id}/image?type=season`}
                  title={t.title}
                  aspectRatio="square"
                  fallbackIcon="music"
                  onClick={() => router.push(`/library/music/track/${t.id}`)}
                  metadata={
                    <MetadataLine stacked>
                      {show("metadata", "trackNumber") && t.episodeNumber != null && (
                        <MetadataItem icon={<List />}>Track {t.episodeNumber}</MetadataItem>
                      )}
                      {show("metadata", "duration") && formatDuration(t.duration) && <MetadataItem icon={<Clock />}>{formatDuration(t.duration)}</MetadataItem>}
                      {show("metadata", "fileSize") && formatFileSize(t.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(t.fileSize)}</MetadataItem>}
                    </MetadataLine>
                  }
                  badges={
                    <>
                      {show("badges", "audioCodec") && t.audioCodec && (
                        <Badge className="text-[10px] px-1.5 py-0" variant="outline">
                          {t.audioCodec.toUpperCase()}
                        </Badge>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
