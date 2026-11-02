"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChip } from "@/components/quality-chips";
import { QualityBar } from "@/components/media-card";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { DetailPageStates, genreChips } from "@/components/media-detail-parts";
import { FadeImage } from "@/components/ui/fade-image";
import { ColorChip } from "@/components/color-chip";
import { MediaHoverPopover, hoverDataFromAlbum } from "@/components/media-hover-popover";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Separator } from "@/components/ui/separator";
import { formatFileSize } from "@/lib/format";
import { useMediaDetailRecord } from "@/hooks/use-media-detail-record";
import { useDetailChildren } from "@/hooks/use-detail-children";

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
  ["Artist", "grandparentRatingKey"],
  ["Album", "parentRatingKey"],
  ["Track", "ratingKey"],
];

const pickAlbums = (body: Record<string, unknown>) => body.albums as AlbumData[] | undefined;

export default function ArtistDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { getHex } = useChipColors();
  // The albums are asked for by this page's id, beside the record — they used
  // to wait for it, to read its artist — and both are re-read together on
  // every `sync:completed` (new/removed items) without a manual refresh. No
  // integration cards here, so no Lidarr lookup is started.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "MUSIC",
    plays: false,
    integrations: false,
    playLinks: PLAY_LINKS,
    refetchOnTick: true,
    children: "albums",
  });
  const albumList = useDetailChildren(id, "albums", syncTick, pickAlbums);

  // The page renders with its albums, as it did when it waited for both in turn.
  const pending = loading || (item !== null && !albumList.loaded);
  if (pending || !item) return <DetailPageStates loading={pending} notFoundLabel="Artist not found" />;

  const albums = albumList.items;
  const artistName = item.parentTitle || item.title;
  const totalTracks = albums.reduce((sum, a) => sum + a.trackCount, 0);
  const totalSize = albums.reduce((sum, a) => sum + (a.totalSize ? Number(a.totalSize) : 0), 0);

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
          {qualityChips({ audioCodecCounts: codecCounts }, "music").map((chip) => (
            <QualityChip key={chip.label} chip={chip} />
          ))}
          {totalSize > 0 && (
            <ColorChip className="border-border text-muted-foreground">{formatFileSize(totalSize.toString())}</ColorChip>
          )}
        </>
      }
      genres={genreChips(item.genres)}
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
                      <QualityBar
                        segments={qualitySegments(qualityChips({ audioCodecCounts: a.audioCodecCounts }, "music"), getHex)}
                        className="px-1 py-0.5 bg-transparent"
                      />
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
                    data={hoverDataFromAlbum(a)}
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
