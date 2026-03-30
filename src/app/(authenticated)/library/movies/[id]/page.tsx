"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { RatingChip } from "@/components/rating-chip";
import { getRatingLabel } from "@/lib/rating-labels";
import { MediaDetailContent } from "@/components/media-detail-content";
import { Badge } from "@/components/ui/badge";
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
  const { id } = useParams<{ id: string }>();
  const { getBadgeStyle } = useChipColors();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchItem() {
      try {
        const res = await fetch(`/api/media/${id}`);
        const data = await res.json();
        if (data.item) {
          setItem(data.item);
          setPlayServers(data.playServers || []);
        }
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
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
            <Badge variant="secondary" style={getBadgeStyle("resolution", formatResolution(item.resolution))}>
              {formatResolution(item.resolution)}
            </Badge>
          )}
          {item.dynamicRange && (
            <Badge variant="secondary" style={getBadgeStyle("dynamicRange", item.dynamicRange)}>
              {item.dynamicRange}
            </Badge>
          )}
          {item.audioProfile && (
            <Badge variant="secondary" style={getBadgeStyle("audioProfile", item.audioProfile)}>
              {item.audioProfile}
            </Badge>
          )}
          {item.fileSize && (
            <Badge variant="outline">{formatFileSize(item.fileSize)}</Badge>
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
              <Badge key={genre} variant="secondary" className="text-xs bg-white/10 text-white/80 border-white/20">
                {genre}
              </Badge>
            ))
          : undefined
      }
      filePath={item.filePath}
      backHref="/library/movies"
      backLabel="Movies"
      playServers={playServers}
    >
      <MediaDetailContent item={item} />
    </MediaDetailHero>
  );
}
