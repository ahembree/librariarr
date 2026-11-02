"use client";

import { useParams } from "next/navigation";
import { QualityChip } from "@/components/quality-chips";
import { qualityChips } from "@/lib/media/quality-chips";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { DetailPageStates, RatingChips, genreChips } from "@/components/media-detail-parts";
import { ColorChip } from "@/components/color-chip";
import { formatFileSize, formatDuration } from "@/lib/format";
import { formatEpisodeCode } from "@/lib/media/display-title";
import { useBackOverride, useMediaDetailRecord } from "@/hooks/use-media-detail-record";
import { PlayHistory } from "@/components/play-history";

const PLAY_LINKS: Parameters<typeof useMediaDetailRecord>[1]["playLinks"] = [
  ["Episode", "ratingKey"],
  ["Season", "parentRatingKey"],
  ["Series", "grandparentRatingKey"],
];

const BACK_LABELS = {
  "/library/series/episodes": "All Episodes",
  "/library/series/seasons": "All Seasons",
};

export default function EpisodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  // The watch-history card below reads the *stored* WatchHistory table, so —
  // unlike the live per-user card it replaced — it only changes when a sync
  // lands: the record is re-read on `sync:completed`, as the show and season
  // pages do. The Arr/Seerr cards need only the id, so their requests start
  // beside the record's, once per id.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "SERIES",
    plays: false,
    playLinks: PLAY_LINKS,
    refetchOnTick: true,
  });
  const backOverride = useBackOverride(BACK_LABELS);

  if (loading || !item) return <DetailPageStates loading={loading} notFoundLabel="Episode not found" />;

  const episodeLabel =
    item.seasonNumber != null && item.episodeNumber != null
      ? formatEpisodeCode(item.seasonNumber, item.episodeNumber)
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
          {qualityChips(item, "video").map((chip) => (
            <QualityChip key={chip.category} chip={chip} />
          ))}
          {item.fileSize && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(item.fileSize)}</ColorChip>
          )}
        </>
      }
      ratings={<RatingChips item={item} />}
      genres={genreChips(item.genres)}
      filePath={item.filePath}
      artUrl={`/api/media/${item.id}/image`}
      backHref={backOverride?.href ?? `/library/series/show/${item.id}`}
      backLabel={backOverride?.label ?? (item.parentTitle || "Series")}
      useParentArt
      playServers={playServers}
    >
      <MediaDetailContent
        item={item}
        record={item}
        detailLoaded
        // The per-play list *is* this episode's Watch History card. It replaces
        // the per-user aggregate card (which reads the same plays live from the
        // server, minus the timestamps), so the page shows the data once.
        historySection={
          item.parentTitle && item.seasonNumber != null && item.episodeNumber != null ? (
            <PlayHistory
              variant="card"
              seriesKey={item.seriesKey}
              parentTitle={item.parentTitle}
              seasonNumber={item.seasonNumber}
              episodeNumber={item.episodeNumber}
              currentEpisode
              refreshKey={syncTick}
            />
          ) : undefined
        }
      />
    </MediaDetailHero>
  );
}
