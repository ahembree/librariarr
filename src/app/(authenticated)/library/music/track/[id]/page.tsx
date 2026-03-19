"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaDetailContent } from "@/components/media-detail-content";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize, formatDuration } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";

export default function TrackDetailPage() {
  const { id } = useParams<{ id: string }>();
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
            ["Track", "ratingKey"],
            ["Album", "parentRatingKey"],
            ["Artist", "grandparentRatingKey"],
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
            <Badge variant="outline">
              {item.audioCodec.toUpperCase()}
              {item.audioChannels ? ` ${item.audioChannels}ch` : ""}
            </Badge>
          )}
          {item.fileSize && (
            <Badge variant="outline">{formatFileSize(item.fileSize)}</Badge>
          )}
        </>
      }
      filePath={item.filePath}
      backHref={`/library/music/album/${item.id}`}
      backLabel={item.parentTitle || "Album"}
      useParentArt
      posterAspectRatio="1/1"
      playServers={playServers}
    >
      <MediaDetailContent item={item} hideVideo />
    </MediaDetailHero>
  );
}
