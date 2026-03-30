"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { FadeImage } from "@/components/ui/fade-image";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFileSize } from "@/lib/format";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";

interface AlbumData {
  albumTitle: string;
  trackCount: number;
  totalSize: string;
  audioCodecCounts: Record<string, number>;
  mediaItemId: string;
}

export default function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [albums, setAlbums] = useState<AlbumData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const itemRes = await fetch(`/api/media/${id}`);
        const itemData = await itemRes.json();
        if (!itemData.item) return;
        setItem(itemData.item);
        setPlayServers(buildPlayLinks(itemData.playServers || [], [
          ["Artist", "grandparentRatingKey"],
          ["Album", "parentRatingKey"],
          ["Track", "ratingKey"],
        ]));

        const artistName = itemData.item.parentTitle || itemData.item.title;
        const albumsRes = await fetch(`/api/media/music/albums?parentTitle=${encodeURIComponent(artistName)}`);
        const albumsData = await albumsRes.json();
        setAlbums(albumsData.albums || []);
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
        <p className="text-muted-foreground">Artist not found</p>
      </div>
    );
  }

  const artistName = item.parentTitle || item.title;
  const totalTracks = albums.reduce((sum, a) => sum + a.trackCount, 0);
  const totalSize = albums.reduce((sum, a) => sum + Number(a.totalSize), 0);

  // Audio codec breakdown across all albums
  const codecCounts: Record<string, number> = {};
  for (const a of albums) {
    for (const [codec, count] of Object.entries(a.audioCodecCounts)) {
      codecCounts[codec] = (codecCounts[codec] || 0) + count;
    }
  }

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=parent`}
      title={artistName}
      subtitle={
        <>
          <span>{albums.length} album{albums.length !== 1 ? "s" : ""}</span>
          <span> &middot; {totalTracks} track{totalTracks !== 1 ? "s" : ""}</span>
        </>
      }
      badges={
        <>
          {Object.entries(codecCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([codec, count]) => (
              <Badge key={codec} variant="outline">
                {codec}: {count}
              </Badge>
            ))}
          {totalSize > 0 && (
            <Badge variant="outline">{formatFileSize(totalSize.toString())}</Badge>
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
      backHref="/library/music"
      backLabel="Music"
      useParentArt
      posterAspectRatio="1/1"
      playServers={playServers}
    >
      {item.summary && (
        <div className="mt-6">
          <p className="text-sm text-muted-foreground leading-relaxed">{item.summary}</p>
        </div>
      )}

      {albums.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Albums
          </h2>
          <div className="flex flex-wrap gap-3">
            {albums.map((a) => (
              <Link
                key={a.mediaItemId}
                href={`/library/music/album/${a.mediaItemId}`}
                className="group w-[110px] sm:w-[130px] lg:w-[150px] rounded-lg transition-transform duration-200 hover:scale-[1.03]"
              >
                <div
                  className="relative overflow-hidden rounded-lg bg-muted"
                  style={{ aspectRatio: "1/1" }}
                >
                  <FadeImage
                    src={`/api/media/${a.mediaItemId}/image?type=season`}
                    alt={a.albumTitle}
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover group-hover:opacity-80"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-foreground">
                  {a.albumTitle}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {a.trackCount} track{a.trackCount !== 1 ? "s" : ""}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
