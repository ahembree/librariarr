"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize, formatDuration } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "Unknown";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

export default function EpisodeDetailPage() {
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
          setPlayServers(buildPlayLinks(data.playServers || [], [
            ["Episode", "ratingKey"],
            ["Season", "parentRatingKey"],
            ["Series", "grandparentRatingKey"],
          ]));
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
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Episode not found</p>
      </div>
    );
  }

  const episodeLabel =
    item.seasonNumber != null && item.episodeNumber != null
      ? `S${String(item.seasonNumber).padStart(2, "0")}E${String(item.episodeNumber).padStart(2, "0")}`
      : null;

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=parent`}
      title={item.parentTitle || item.title}
      tagline={item.tagline}
      subtitle={
        <>
          {episodeLabel && <span>{episodeLabel}</span>}
          {episodeLabel && item.title && <span> &middot; </span>}
          {item.title && <span>{item.title}</span>}
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
          {item.rating != null && (
            <span className="text-white/60">
              Critic: <span className="font-medium text-white/90">{item.rating.toFixed(1)}</span>
            </span>
          )}
          {item.audienceRating != null && (
            <span className="text-white/60">
              Audience: <span className="font-medium text-white/90">{item.audienceRating.toFixed(1)}</span>
            </span>
          )}
          {item.userRating != null && (
            <span className="text-white/60">
              You: <span className="font-medium text-white/90">{item.userRating.toFixed(1)}</span>
            </span>
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
      filePath={item.filePath}
      artUrl={`/api/media/${item.id}/image`}
      backHref={`/library/series/season/${item.id}`}
      backLabel={item.seasonNumber != null ? (item.seasonNumber === 0 ? "Specials" : `Season ${item.seasonNumber}`) : "Season"}
      useParentArt
      playServers={playServers}
    >
      <MediaDetailContent item={item} />
    </MediaDetailHero>
  );
}
