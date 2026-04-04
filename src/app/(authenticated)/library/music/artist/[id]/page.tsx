"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useChipColors } from "@/components/chip-color-provider";
import { AUDIO_CODEC_ORDER } from "@/lib/theme/chip-colors";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { FadeImage } from "@/components/ui/fade-image";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
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
  totalPlayCount: number;
  lastPlayed: string | null;
  addedAt: string | null;
  servers: { serverId: string; serverName: string; serverType: string }[];
}

export default function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { getBadgeStyle, getHex } = useChipColors();
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
          {[
            ...AUDIO_CODEC_ORDER.filter((c) => codecCounts[c]).map((c) => [c, codecCounts[c]] as const),
            ...Object.entries(codecCounts).filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c)),
          ].map(([codec, count]) => (
              <ColorChip key={codec} style={getBadgeStyle("audioCodec", codec)}>
                {codec}: {count}
              </ColorChip>
            ))}
          {totalSize > 0 && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(totalSize.toString())}</ColorChip>
          )}
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
              <HoverCard key={a.mediaItemId} openDelay={400} closeDelay={150}>
                <HoverCardTrigger asChild>
                  <Link
                    href={`/library/music/album/${a.mediaItemId}`}
                    className="group w-[110px] sm:w-[130px] lg:w-[150px] rounded-lg transition-transform duration-200 hover:scale-[1.03]"
                  >
                    <div
                      className="relative overflow-hidden rounded-t-lg bg-muted"
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
                    {Object.keys(a.audioCodecCounts).length > 0 && (
                      <div className="flex w-full gap-1 px-1 py-0.5">
                        {[
                          ...AUDIO_CODEC_ORDER.filter((c) => a.audioCodecCounts[c]).map((codec) => ({ color: getHex("audioCodec", codec), weight: a.audioCodecCounts[codec], label: `${codec}: ${a.audioCodecCounts[codec]}` })),
                          ...Object.entries(a.audioCodecCounts).filter(([c]) => !(AUDIO_CODEC_ORDER as readonly string[]).includes(c)).map(([codec, count]) => ({ color: getHex("audioCodec", codec), weight: count, label: `${codec}: ${count}` })),
                        ].map((seg, i) => (
                          <div key={i} className="h-1 min-w-1 rounded-full" style={{ backgroundColor: seg.color, flex: seg.weight }} title={seg.label} />
                        ))}
                      </div>
                    )}
                    <p className="mt-1 truncate text-xs font-medium text-foreground">
                      {a.albumTitle}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {a.trackCount} track{a.trackCount !== 1 ? "s" : ""}
                    </p>
                  </Link>
                </HoverCardTrigger>
                <HoverCardContent side="right" align="start" sideOffset={8} className="w-72 p-0 duration-200">
                  <MediaHoverPopover
                    imageUrl={`/api/media/${a.mediaItemId}/image?type=season`}
                    imageAspect="square"
                    data={{
                      title: a.albumTitle,
                      trackCount: a.trackCount,
                      fileSize: a.totalSize,
                      playCount: a.totalPlayCount,
                      lastPlayedAt: a.lastPlayed,
                      addedAt: a.addedAt,
                      servers: a.servers,
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
