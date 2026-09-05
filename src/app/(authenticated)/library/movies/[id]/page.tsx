"use client";

import { useState, useEffect, useRef } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useParams } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { RatingChip } from "@/components/rating-chip";
import { getRatingLabel } from "@/lib/rating-labels";
import { MediaDetailContent } from "@/components/media-detail-content";
import { PlayHistory } from "@/components/play-history";
import { ColorChip } from "@/components/color-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize, formatDuration } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import type { PlayServer } from "@/lib/play-url";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "Unknown";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

export default function MovieDetailPage() {
  // The play-history card below reads the *stored* WatchHistory table, so it
  // only changes when a sync or an import lands. These were the only two media
  // detail pages with no subscription at all.
  const [syncTick, setSyncTick] = useState(0);
  useRealtime("sync:completed", () => setSyncTick((t) => t + 1));
  useRealtime("watch-history:updated", () => setSyncTick((t) => t + 1));
  const { id } = useParams<{ id: string }>();
  const { getBadgeStyle } = useChipColors();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [loading, setLoading] = useState(true);
  // Token guards against a stale slow response landing after a quick id change.
  const reqToken = useRef(0);

  useEffect(() => {
    const token = ++reqToken.current;
    async function fetchItem() {
      try {
        const res = await fetch(`/api/media/${id}`);
        const data = await res.json();
        if (token !== reqToken.current) return;
        if (data.item) {
          setItem(data.item);
          setPlayServers(data.playServers || []);
        }
      } catch {
        // Failed to load
      } finally {
        if (token === reqToken.current) setLoading(false);
      }
    }
    fetchItem();
  }, [id]);

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
        <p className="text-muted-foreground">Movie not found</p>
      </div>
    );
  }

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image`}
      title={item.title}
      tagline={item.tagline}
      subtitle={
        <>
          {item.year && <span>{item.year}</span>}
          {item.contentRating && <span> &middot; {item.contentRating}</span>}
          {item.studio && <span> &middot; {item.studio}</span>}
          {item.duration && <span> &middot; {formatDuration(item.duration)}</span>}
        </>
      }
      badges={
        <>
          {item.resolution && (
            <ColorChip style={getBadgeStyle("resolution", formatResolution(item.resolution))}>
              {formatResolution(item.resolution)}
            </ColorChip>
          )}
          {item.dynamicRange && (
            <ColorChip style={getBadgeStyle("dynamicRange", item.dynamicRange)}>
              {item.dynamicRange}
            </ColorChip>
          )}
          {item.audioProfile && (
            <ColorChip style={getBadgeStyle("audioProfile", item.audioProfile)}>
              {item.audioProfile}
            </ColorChip>
          )}
          {item.fileSize && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(item.fileSize)}</ColorChip>
          )}
        </>
      }
      ratings={
        <>
          {item.rating != null && <RatingChip label={getRatingLabel(item.ratingImage, item.library?.mediaServer?.type, "rating", "Critic")} value={item.rating} />}
          {item.audienceRating != null && <RatingChip label={getRatingLabel(item.audienceRatingImage, item.library?.mediaServer?.type, "audienceRating", "Audience")} value={item.audienceRating} />}
          {item.userRating != null && <RatingChip label="You" value={item.userRating} />}
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
      filePath={item.filePath}
      backHref="/library/movies"
      backLabel="Movies"
      playServers={playServers}
    >
      <MediaDetailContent item={item} 
        // The per-play list *is* this movie's Watch History card. It replaces the
        // per-user aggregate card, which reads the same plays live from the
        // server but without their timestamps, device, or any of the
        // completion/transcode detail a Tracearr-sourced row carries — so the
        // page shows the richer view rather than the same data twice.
        historySection={<PlayHistory variant="card" mediaItemId={item.id} singleItem refreshKey={syncTick} />}
      />
    </MediaDetailHero>
  );
}
