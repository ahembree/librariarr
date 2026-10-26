"use client";

import { useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/utils";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChip } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { DetailPageStates, genreChips } from "@/components/media-detail-parts";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { ColorChip } from "@/components/color-chip";
import { Separator } from "@/components/ui/separator";
import { LayoutGrid, TableProperties, List, Clock, HardDrive } from "lucide-react";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import type { MediaItemWithRelations, MediaListItem } from "@/lib/types";
import { useBackOverride, useMediaDetailRecord } from "@/hooks/use-media-detail-record";
import { useDetailChildren } from "@/hooks/use-detail-children";
import { MediaHoverPopover, hoverDataFromListItem, hoverSummaryUrl } from "@/components/media-hover-popover";

// Numeric string fields (fileSize is BigInt-as-string) must compare as
// numbers, not lexicographically ("9000" must sort before "10000").
const NUMERIC_STRING_FIELDS = new Set(["fileSize"]);

const PLAY_LINKS: Parameters<typeof useMediaDetailRecord>[1]["playLinks"] = [
  ["Album", "parentRatingKey"],
  ["Artist", "grandparentRatingKey"],
  ["Track", "ratingKey"],
];

const BACK_LABELS = {
  "/library/music/albums": "All Albums",
  "/library/music/tracks": "All Tracks",
};

const pickTracks = (body: Record<string, unknown>) => body.items as MediaListItem[] | undefined;

// Named by its own title: the artist and album are the page's heading.
function trackTableHover(track: MediaListItem) {
  return (
    <MediaHoverPopover
      summaryUrl={hoverSummaryUrl(track.id)}
      imageUrl={`/api/media/${track.id}/image`}
      imageAspect="square"
      data={hoverDataFromListItem(track)}
    />
  );
}

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("MUSIC_TRACKS");
  const { size, setSize, gridStyle } = useCardSize();
  // The tracks are asked for by this page's id, beside the record — they used
  // to wait for it, to read its artist and album — and both are re-read
  // together on every `sync:completed` (new/removed items) without a manual
  // refresh. No integration cards here, so no Lidarr lookup is started.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "MUSIC",
    plays: false,
    integrations: false,
    playLinks: PLAY_LINKS,
    refetchOnTick: true,
    children: "tracks",
  });
  const trackList = useDetailChildren(id, "tracks", syncTick, pickTracks);
  const tracks = trackList.items;
  const [viewMode, handleViewModeChange] = useLocalStorage<"cards" | "table">(
    "album-detail-view-mode",
    "table",
  );
  const [sortBy, setSortBy] = useState("episodeNumber");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const backOverride = useBackOverride(BACK_LABELS);

  const handleSort = useCallback(
    (field: string) => {
      if (field === sortBy) {
        setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setSortOrder("asc");
      }
    },
    [sortBy]
  );

  const openTrack = useCallback((track: MediaListItem) => router.push(`/library/music/track/${track.id}`), [router]);

  const sortedTracks = useMemo(() => {
    const sorted = [...tracks].sort((a, b) => {
      const aVal = a[sortBy as keyof MediaListItem];
      const bVal = b[sortBy as keyof MediaListItem];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (NUMERIC_STRING_FIELDS.has(sortBy)) return Number(aVal) - Number(bVal);
      if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal);
      if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
      return String(aVal).localeCompare(String(bVal));
    });
    return sortOrder === "desc" ? sorted.reverse() : sorted;
  }, [tracks, sortBy, sortOrder]);

  // The page renders with its tracks, as it did when it waited for both in turn.
  const pending = loading || (item !== null && !trackList.loaded);
  if (pending || !item) return <DetailPageStates loading={pending} notFoundLabel="Album not found" />;

  const artistName = item.parentTitle || "Unknown Artist";
  const albumTitle = (item as MediaItemWithRelations & { albumTitle?: string | null }).albumTitle || item.title;
  const totalSize = tracks.reduce((sum, t) => sum + (t.fileSize ? Number(t.fileSize) : 0), 0);

  // Audio codec breakdown
  const codecCounts: Record<string, number> = {};
  for (const t of tracks) {
    const codec = t.audioCodec ? t.audioCodec.toUpperCase() : "Unknown";
    codecCounts[codec] = (codecCounts[codec] || 0) + 1;
  }

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=season`}
      title={artistName}
      subtitle={
        <>
          <span>{albumTitle}</span>
          <span> &middot; {tracks.length} track{tracks.length !== 1 ? "s" : ""}</span>
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
      backHref={backOverride?.href ?? `/library/music/artist/${item.id}`}
      backLabel={backOverride?.label ?? artistName}
      useParentArt
      posterAspectRatio="1/1"
      playServers={playServers}
    >
      {tracks.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Tracks
            </h2>
            <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
              <button
                onClick={() => handleViewModeChange("cards")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "cards"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
                title="Card view"
                aria-label="Card view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleViewModeChange("table")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "table"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
                title="Table view"
                aria-label="Table view"
              >
                <TableProperties className="h-4 w-4" />
              </button>
            </div>
            {viewMode === "cards" && (
              <>
                <CardSizeControl size={size} onChange={setSize} />
                <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.MUSIC_TRACKS} onToggle={setVisible} />
              </>
            )}
          </div>

          {viewMode === "table" ? (
            <MediaTable
              items={sortedTracks}
              onItemClick={openTrack}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="MUSIC"
              hideParentTitle
              renderHoverContent={trackTableHover}
            />
          ) : (
            <div style={gridStyle}>
              {sortedTracks.map((t) => (
                <MediaCard
                  key={t.id}
                  imageUrl={`/api/media/${t.id}/image?type=season`}
                  title={t.title}
                  aspectRatio="square"
                  fallbackIcon="music"
                  href={`/library/music/track/${t.id}`}
                  prefetchMediaId={t.id}
                  hoverContent={<MediaHoverPopover summaryUrl={hoverSummaryUrl(t.id)} data={hoverDataFromListItem(t)} />}
                  metadata={
                    <MetadataLine stacked>
                      {show("metadata", "trackNumber") && t.episodeNumber != null && (
                        <MetadataItem icon={<List />}>Track {t.episodeNumber}</MetadataItem>
                      )}
                      {show("metadata", "duration") && formatDuration(t.duration) && <MetadataItem icon={<Clock />}>{formatDuration(t.duration)}</MetadataItem>}
                      {show("metadata", "fileSize") && formatFileSize(t.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(t.fileSize)}</MetadataItem>}
                    </MetadataLine>
                  }
                  qualityBar={qualitySegments(qualityChips(t, "music"), getHex, (toggle) => show("badges", toggle))}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
