"use client";

import { useParams } from "next/navigation";
import { QualityChip } from "@/components/quality-chips";
import { qualityChips } from "@/lib/media/quality-chips";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { DetailPageStates, RatingChips, genreChips } from "@/components/media-detail-parts";
import { PlayHistory } from "@/components/play-history";
import { ColorChip } from "@/components/color-chip";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useMediaDetailRecord } from "@/hooks/use-media-detail-record";

// The play-history card below reads the *stored* WatchHistory table, so it
// only changes when a sync or an import lands.
const TICK_ON = ["sync:completed", "watch-history:updated"] as const;

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>();
  // The play history and the Arr/Seerr cards need only the id, so their
  // requests start beside the record's instead of after it renders.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "MOVIE",
    plays: true,
    tickOn: TICK_ON,
  });

  if (loading || !item) return <DetailPageStates loading={loading} notFoundLabel="Movie not found" />;

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
      backHref="/library/movies"
      backLabel="Movies"
      playServers={playServers}
    >
      <MediaDetailContent
        item={item}
        record={item}
        detailLoaded
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
