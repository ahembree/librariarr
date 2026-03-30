"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { RatingChip } from "@/components/rating-chip";
import { getRatingLabel } from "@/lib/rating-labels";
import { FadeImage } from "@/components/ui/fade-image";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";
import { ArrSection } from "@/components/arr-link-button";

function formatResolution(resolution: string): string {
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

interface SeasonData {
  seasonNumber: number;
  episodeCount: number;
  totalSize: string;
  qualityCounts: Record<string, number>;
  mediaItemId: string;
  lastPlayed: string | null;
  totalPlayCount: number;
}

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { getBadgeStyle } = useChipColors();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [seasons, setSeasons] = useState<SeasonData[]>([]);
  const [seriesSummary, setSeriesSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const itemRes = await fetch(`/api/media/${id}`);
        const itemData = await itemRes.json();
        if (!itemData.item) return;
        setItem(itemData.item);
        setPlayServers(buildPlayLinks(itemData.playServers || [], [
          ["Series", "grandparentRatingKey"],
          ["Season", "parentRatingKey"],
          ["Episode", "ratingKey"],
        ]));

        const parentTitle = itemData.item.parentTitle || itemData.item.title;
        const [seasonsRes, summaryRes] = await Promise.all([
          fetch(`/api/media/series/seasons?parentTitle=${encodeURIComponent(parentTitle)}`),
          fetch(`/api/media/${id}/series-summary`),
        ]);
        const seasonsData = await seasonsRes.json();
        setSeasons(seasonsData.seasons || []);
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          if (summaryData.summary) setSeriesSummary(summaryData.summary);
        }
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
      }
    }
    fetchData();
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
        <p className="text-muted-foreground">Series not found</p>
      </div>
    );
  }

  const seriesTitle = item.parentTitle || item.title;
  const totalEpisodes = seasons.reduce((sum, s) => sum + s.episodeCount, 0);
  const totalSize = seasons.reduce((sum, s) => sum + Number(s.totalSize), 0);

  // Quality breakdown across all seasons
  const qualityCounts: Record<string, number> = {};
  for (const s of seasons) {
    for (const [label, count] of Object.entries(s.qualityCounts)) {
      qualityCounts[label] = (qualityCounts[label] || 0) + count;
    }
  }

  const seasonItems = seasons.map((s) => ({
    id: s.mediaItemId,
    title: s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`,
    imageUrl: `/api/media/${s.mediaItemId}/image?type=season`,
    href: `/library/series/season/${s.mediaItemId}`,
    subtitle: `${s.episodeCount} episode${s.episodeCount !== 1 ? "s" : ""}`,
    qualityCounts: s.qualityCounts,
  }));

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=parent`}
      title={seriesTitle}
      subtitle={
        <>
          <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
          <span> &middot; {totalEpisodes} episode{totalEpisodes !== 1 ? "s" : ""}</span>
        </>
      }
      badges={
        <>
          {Object.entries(qualityCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([label, count]) => (
              <Badge key={label} variant="secondary" style={getBadgeStyle("resolution", formatResolution(label))}>
                {formatResolution(label)}: {count}
              </Badge>
            ))}
          {totalSize > 0 && (
            <Badge variant="outline">{formatFileSize(totalSize.toString())}</Badge>
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
      backHref="/library/series"
      backLabel="Series"
      useParentArt
      playServers={playServers}
    >
      {(seriesSummary || item.summary) && (
        <div className="mt-6">
          <p className="text-sm text-muted-foreground leading-relaxed">{seriesSummary || item.summary}</p>
        </div>
      )}

      <div className="mt-6">
        <ArrSection itemId={item.id} mediaType="SERIES" />
      </div>

      {seasonItems.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Seasons
          </h2>
          <div className="flex flex-wrap gap-3">
            {seasonItems.map((s) => (
              <Link
                key={s.id}
                href={s.href}
                className="group w-[110px] sm:w-[130px] lg:w-[150px] rounded-lg transition-transform duration-200 hover:scale-[1.03]"
              >
                <div
                  className="relative overflow-hidden rounded-lg bg-muted"
                  style={{ aspectRatio: "2/3" }}
                >
                  <FadeImage
                    src={s.imageUrl}
                    alt={s.title}
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover group-hover:opacity-80"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-foreground">
                  {s.title}
                </p>
                {s.subtitle && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {s.subtitle}
                  </p>
                )}
                {Object.keys(s.qualityCounts).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {Object.entries(s.qualityCounts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([label, count]) => (
                        <Badge
                          key={label}
                          variant="secondary"
                          className="px-1 py-0 text-[9px] leading-tight"
                          style={getBadgeStyle("resolution", formatResolution(label))}
                        >
                          {formatResolution(label)}: {count}
                        </Badge>
                      ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
