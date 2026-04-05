"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useChipColors } from "@/components/chip-color-provider";
import { AUDIO_CODEC_ORDER } from "@/lib/theme/chip-colors";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { ColorChip } from "@/components/color-chip";
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
import { MediaHoverPopover } from "@/components/media-hover-popover";

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { getBadgeStyle, getHex } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("MUSIC_TRACKS");
  const { size, setSize, gridStyle } = useCardSize();
  const [item, setItem] = useState<(MediaItemWithRelations & { albumTitle?: string | null }) | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [tracks, setTracks] = useState<MediaItemWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"cards" | "table">("table");
  const [sortBy, setSortBy] = useState("episodeNumber");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [backOverride, setBackOverride] = useState<{ href: string; label: string } | null>(null);

  useEffect(() => {
    const backPath = sessionStorage.getItem("library-back-path");
    if (backPath) {
      sessionStorage.removeItem("library-back-path");
      const labels: Record<string, string> = {
        "/library/music/albums": "All Albums",
        "/library/music/tracks": "All Tracks",
      };
      const label = labels[backPath];
      if (label) setBackOverride({ href: backPath, label });
    }
  }, []);

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
          {[
            ...AUDIO_CODEC_ORDER.filter((c) => codecCounts[c]).map((c) => [c, codecCounts[c]] as const),
            ...Object.entries(codecCounts).filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c)),
          ].map(([codec, count]) => (
              <ColorChip key={codec} style={getBadgeStyle("audioCodec", codec)}>
                {codec}: {count}
              </ColorChip>
            ))}
          {totalSize > 0 && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(totalSize.toString())}</ColorChip>
          )}
        </>
      }
      genres={
        item.genres && item.genres.length > 0
          ? item.genres.map((genre) => (
              <ColorChip key={genre} className="bg-white/10 text-white/80 border-white/20">
                {genre}
              </ColorChip>
            ))
          : undefined
      }
      backHref={backOverride?.href ?? `/library/music/artist/${item.id}`}
      backLabel={backOverride?.label ?? artistName}
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
              renderHoverContent={(track) => (
                <MediaHoverPopover
                  imageUrl={`/api/media/${track.id}/image`}
                  imageAspect="square"
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
              )}
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
                  href={`/library/music/track/${t.id}`}
                  hoverContent={
                    <MediaHoverPopover
                      data={{
                        title: t.title,
                        year: t.year,
                        summary: t.summary,
                        contentRating: t.contentRating,
                        rating: t.rating,
                        audienceRating: t.audienceRating,
                        ratingImage: t.ratingImage,
                        audienceRatingImage: t.audienceRatingImage,
                        duration: t.duration,
                        resolution: t.resolution,
                        dynamicRange: t.dynamicRange,
                        audioProfile: t.audioProfile,
                        audioCodecCounts: t.audioCodec ? { [t.audioCodec.toUpperCase()]: 1 } : undefined,
                        fileSize: t.fileSize,
                        genres: t.genres,
                        studio: t.studio,
                        playCount: t.playCount,
                        lastPlayedAt: t.lastPlayedAt,
                        addedAt: t.addedAt,
                        servers: t.servers,
                      }}
                    />
                  }
                  metadata={
                    <MetadataLine stacked>
                      {show("metadata", "trackNumber") && t.episodeNumber != null && (
                        <MetadataItem icon={<List />}>Track {t.episodeNumber}</MetadataItem>
                      )}
                      {show("metadata", "duration") && formatDuration(t.duration) && <MetadataItem icon={<Clock />}>{formatDuration(t.duration)}</MetadataItem>}
                      {show("metadata", "fileSize") && formatFileSize(t.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(t.fileSize)}</MetadataItem>}
                    </MetadataLine>
                  }
                  qualityBar={
                    show("badges", "audioCodec") && t.audioCodec
                      ? [{ color: getHex("audioCodec", t.audioCodec.toUpperCase()), weight: 1, label: t.audioCodec.toUpperCase() }]
                      : undefined
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
