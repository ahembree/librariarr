"use client";

import { useParams } from "next/navigation";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { DetailPageStates } from "@/components/media-detail-parts";
import { PlayHistory } from "@/components/play-history";
import { ColorChip } from "@/components/color-chip";
import { QualityChip } from "@/components/quality-chips";
import { qualityChips } from "@/lib/media/quality-chips";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useBackOverride, useMediaDetailRecord } from "@/hooks/use-media-detail-record";

// The play-history card below reads the *stored* WatchHistory table, so it
// only changes when a sync or an import lands.
const TICK_ON = ["sync:completed", "watch-history:updated"] as const;

const PLAY_LINKS: Parameters<typeof useMediaDetailRecord>[1]["playLinks"] = [
  ["Track", "ratingKey"],
  ["Album", "parentRatingKey"],
  ["Artist", "grandparentRatingKey"],
];

const BACK_LABELS = {
  "/library/music/tracks": "All Tracks",
  "/library/music/albums": "All Albums",
};

export default function TrackDetailPage() {
  const { id } = useParams<{ id: string }>();
  // The play history and the Arr card need only the id, so their requests
  // start beside the record's instead of after it renders.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "MUSIC",
    plays: true,
    playLinks: PLAY_LINKS,
    tickOn: TICK_ON,
  });
  const backOverride = useBackOverride(BACK_LABELS);

  if (loading || !item) return <DetailPageStates loading={loading} notFoundLabel="Track not found" />;

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=parent`}
      title={item.parentTitle || item.title}
      tagline={item.tagline}
      subtitle={
        <>
          {item.title && <span>{item.title}</span>}
          {item.duration && <span> &middot; {formatDuration(item.duration)}</span>}
        </>
      }
      badges={
        <>
          {qualityChips(item, "music", { channels: true }).map((chip) => (
            <QualityChip key={chip.category} chip={chip} />
          ))}
          {item.fileSize && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(item.fileSize)}</ColorChip>
          )}
        </>
      }
      filePath={item.filePath}
      backHref={backOverride?.href ?? `/library/music/album/${item.id}`}
      backLabel={backOverride?.label ?? (item.parentTitle || "Album")}
      useParentArt
      posterAspectRatio="1/1"
      playServers={playServers}
    >
      <MediaDetailContent
        item={item}
        record={item}
        hideVideo
        detailLoaded
        // The per-play list *is* this track's Listen History card. It replaces the
        // per-user aggregate card, which reads the same plays live from the
        // server but without their timestamps, device, or any of the
        // completion/transcode detail a Tracearr-sourced row carries — so the
        // page shows the richer view rather than the same data twice.
        historySection={<PlayHistory variant="card" mediaItemId={item.id} singleItem heading="Listen History" refreshKey={syncTick} />}
      />
    </MediaDetailHero>
  );
}
