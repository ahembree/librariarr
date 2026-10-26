"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChip } from "@/components/quality-chips";
import { QualityBar } from "@/components/media-card";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { DetailPageStates, RatingChips, genreChips } from "@/components/media-detail-parts";
import { FadeImage } from "@/components/ui/fade-image";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover, hoverDataFromSeriesGroup } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Separator } from "@/components/ui/separator";
import { formatFileSize } from "@/lib/format";
import { useMediaDetailRecord } from "@/hooks/use-media-detail-record";
import { useDetailChildren } from "@/hooks/use-detail-children";
import { IntegrationsSection } from "@/components/integrations-section";
import { PlayHistory } from "@/components/play-history";

interface SeasonData {
  seasonNumber: number;
  episodeCount: number;
  totalSize: string;
  qualityCounts: Record<string, number>;
  mediaItemId: string;
  lastPlayed: string | null;
  addedAt: string | null;
  totalPlayCount: number;
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

const PLAY_LINKS: Parameters<typeof useMediaDetailRecord>[1]["playLinks"] = [
  ["Series", "grandparentRatingKey"],
  ["Season", "parentRatingKey"],
  ["Episode", "ratingKey"],
];

const pickSeasons = (body: Record<string, unknown>) => body.seasons as SeasonData[] | undefined;

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { getHex } = useChipColors();
  // The seasons are asked for by this page's id, beside the record — they used
  // to wait for it, to read its series key — and both are re-read together on
  // every `sync:completed` (new/removed items) without a manual refresh. The
  // Arr/Seerr cards need only the id, so their requests start with them, once
  // per id.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "SERIES",
    plays: false,
    playLinks: PLAY_LINKS,
    refetchOnTick: true,
    children: "seasons",
  });
  const seasonList = useDetailChildren(id, "seasons", syncTick, pickSeasons);
  const [seriesSummary, setSeriesSummary] = useState<string | null>(null);

  // Series summary comes from the live media server — fetch independently so it
  // never blocks the page render when the server is unreachable.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/media/${id}/series-summary`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.summary) setSeriesSummary(data.summary);
      })
      .catch(() => {
        // Server unreachable — page still renders DB data fine.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The page renders with its seasons, as it did when it waited for both in turn.
  const pending = loading || (item !== null && !seasonList.loaded);
  if (pending || !item) return <DetailPageStates loading={pending} notFoundLabel="Series not found" />;

  const seasons = seasonList.items;
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
          {qualityChips({ qualityCounts }, "video").map((chip) => (
            <QualityChip key={chip.label} chip={chip} />
          ))}
          {totalSize > 0 && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(totalSize.toString())}</ColorChip>
          )}
        </>
      }
      ratings={<RatingChips item={item} />}
      genres={genreChips(item.genres)}
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
        <IntegrationsSection itemId={item.id} mediaType="SERIES" />
      </div>

      {seasons.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Seasons
          </h2>
          <div className="flex flex-wrap gap-3">
            {seasons.map((s) => {
              const title = s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`;
              const imageUrl = `/api/media/${s.mediaItemId}/image?type=season`;
              return (
                <HoverCard key={s.mediaItemId} openDelay={400} closeDelay={150}>
                  <HoverCardTrigger asChild>
                    <Link
                      href={`/library/series/season/${s.mediaItemId}`}
                      className="group w-[110px] sm:w-[130px] lg:w-[150px] rounded-lg transition-transform duration-200 hover:scale-[1.03]"
                    >
                      <div
                        className="relative overflow-hidden rounded-t-lg bg-muted"
                        style={{ aspectRatio: "2/3" }}
                      >
                        <FadeImage
                          src={imageUrl}
                          alt={title}
                          loading="lazy"
                          className="absolute inset-0 h-full w-full object-cover group-hover:opacity-80"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                      {Object.keys(s.qualityCounts).length > 0 && (
                        <QualityBar
                          segments={qualitySegments(qualityChips({ qualityCounts: s.qualityCounts }, "video"), getHex)}
                          className="px-1 py-0.5 bg-transparent"
                        />
                      )}
                      <p className="mt-1 truncate text-xs font-medium text-foreground px-0.5">
                        {title}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground px-0.5">
                        {`${s.episodeCount} episode${s.episodeCount !== 1 ? "s" : ""}`}
                      </p>
                    </Link>
                  </HoverCardTrigger>
                  <HoverCardContent side="right" align="start" sideOffset={8} className="w-72 p-0 duration-200">
                    {/* Named as the tile is: the show is the page's own heading. */}
                    <MediaHoverPopover
                      imageUrl={imageUrl}
                      data={hoverDataFromSeriesGroup({ ...s, parentTitle: seriesTitle }, { title })}
                    />
                  </HoverCardContent>
                </HoverCard>
              );
            })}
          </div>
        </section>
      )}

      <PlayHistory seriesKey={item.seriesKey} parentTitle={seriesTitle} refreshKey={syncTick} />

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
