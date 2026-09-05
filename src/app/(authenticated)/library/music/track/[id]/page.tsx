"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { useParams, useSearchParams } from "next/navigation";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { PlayHistory } from "@/components/play-history";
import { ColorChip } from "@/components/color-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize, formatDuration } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";

export default function TrackDetailPage() {
  // The play-history card below reads the *stored* WatchHistory table, so it
  // only changes when a sync or an import lands. These were the only two media
  // detail pages with no subscription at all.
  const [syncTick, setSyncTick] = useState(0);
  useRealtime("sync:completed", () => setSyncTick((t) => t + 1));
  useRealtime("watch-history:updated", () => setSyncTick((t) => t + 1));
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const backOverride = useMemo(() => {
    const from = searchParams.get("from");
    if (!from) return null;
    const labels: Record<string, string> = {
      "/library/music/tracks": "All Tracks",
      "/library/music/albums": "All Albums",
    };
    const label = labels[from];
    return label ? { href: from, label } : null;
  }, [searchParams]);

  // Token guards against a stale slow response landing after the id changes
  // and overwriting the current track's data.
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
          setPlayServers(buildPlayLinks(data.playServers || [], [
            ["Track", "ratingKey"],
            ["Album", "parentRatingKey"],
            ["Artist", "grandparentRatingKey"],
          ]));
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
        <p className="text-muted-foreground">Track not found</p>
      </div>
    );
  }

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
          {item.audioCodec && (
            <ColorChip className="border-border text-muted-foreground">
              {item.audioCodec.toUpperCase()}
              {item.audioChannels ? ` ${item.audioChannels}ch` : ""}
            </ColorChip>
          )}
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
      <MediaDetailContent item={item} hideVideo 
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
