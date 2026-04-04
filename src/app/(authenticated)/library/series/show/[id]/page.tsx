"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useChipColors } from "@/components/chip-color-provider";
import { QUALITY_ORDER } from "@/lib/resolution";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { RatingChip } from "@/components/rating-chip";
import { getRatingLabel } from "@/lib/rating-labels";
import { FadeImage } from "@/components/ui/fade-image";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";
import { ArrSection } from "@/components/arr-link-button";

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
  const { getBadgeStyle, getHex } = useChipColors();
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
    episodeCount: s.episodeCount,
    totalSize: s.totalSize,
    totalPlayCount: s.totalPlayCount,
    lastPlayed: s.lastPlayed,
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
          {QUALITY_ORDER
            .filter((q) => qualityCounts[q])
            .map((label) => (
              <ColorChip key={label} style={getBadgeStyle("resolution", label)}>
                {label}: {qualityCounts[label]}
              </ColorChip>
            ))}
          {totalSize > 0 && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(totalSize.toString())}</ColorChip>
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
              <HoverCard key={s.id} openDelay={400} closeDelay={150}>
                <HoverCardTrigger asChild>
                  <Link
                    href={s.href}
                    className="group w-[110px] sm:w-[130px] lg:w-[150px] rounded-lg transition-transform duration-200 hover:scale-[1.03]"
                  >
                    <div
                      className="relative overflow-hidden rounded-t-lg bg-muted"
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
                    {Object.keys(s.qualityCounts).length > 0 && (
                      <div className="flex w-full gap-1 px-1 py-0.5" aria-hidden="true">
                        {QUALITY_ORDER
                          .filter((q) => s.qualityCounts[q])
                          .map((quality) => (
                            <div
                              key={quality}
                              className="h-1 min-w-1 rounded-full"
                              style={{ backgroundColor: getHex("resolution", quality), flex: s.qualityCounts[quality] }}
                              title={`${quality}: ${s.qualityCounts[quality]}`}
                            />
                          ))}
                      </div>
                    )}
                    <p className="mt-1 truncate text-xs font-medium text-foreground px-0.5">
                      {s.title}
                    </p>
                    {s.subtitle && (
                      <p className="truncate text-[11px] text-muted-foreground px-0.5">
                        {s.subtitle}
                      </p>
                    )}
                  </Link>
                </HoverCardTrigger>
                <HoverCardContent side="right" align="start" sideOffset={8} className="w-72 p-0 duration-200">
                  <MediaHoverPopover
                    imageUrl={s.imageUrl}
                    data={{
                      title: s.title,
                      episodeCount: s.episodeCount,
                      fileSize: s.totalSize,
                      playCount: s.totalPlayCount,
                      lastPlayedAt: s.lastPlayed,
                    }}
                  />
                </HoverCardContent>
              </HoverCard>
            ))}
          </div>
        </section>
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
