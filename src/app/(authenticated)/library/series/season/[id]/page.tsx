"use client";

import { useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useChipColors } from "@/components/chip-color-provider";
import { QualityChip } from "@/components/quality-chips";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { cn } from "@/lib/utils";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { DetailPageStates, genreChips } from "@/components/media-detail-parts";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { ColorChip } from "@/components/color-chip";
import { Separator } from "@/components/ui/separator";
import { LayoutGrid, TableProperties, List, Clock, HardDrive } from "lucide-react";
import { formatFileSize, formatDuration } from "@/lib/format";
import { formatEpisodeCode } from "@/lib/media/display-title";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, SEASON_EPISODE_TOGGLES } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import type { MediaListItem } from "@/lib/types";
import { useBackOverride, useMediaDetailRecord } from "@/hooks/use-media-detail-record";
import { useDetailChildren } from "@/hooks/use-detail-children";
import { IntegrationsSection } from "@/components/integrations-section";
import { MediaHoverPopover, hoverDataFromListItem, hoverSummaryUrl } from "@/components/media-hover-popover";
import { PlayHistory } from "@/components/play-history";

const PLAY_LINKS: Parameters<typeof useMediaDetailRecord>[1]["playLinks"] = [
  ["Season", "parentRatingKey"],
  ["Series", "grandparentRatingKey"],
  ["Episode", "ratingKey"],
];

const BACK_LABELS = {
  "/library/series/seasons": "All Seasons",
  "/library/series/episodes": "All Episodes",
};

const pickEpisodes = (body: Record<string, unknown>) => body.items as MediaListItem[] | undefined;

// Named by its own title: the show and season are the page's heading.
function episodeTableHover(ep: MediaListItem) {
  return (
    <MediaHoverPopover
      summaryUrl={hoverSummaryUrl(ep.id)}
      imageUrl={`/api/media/${ep.id}/image?type=parent`}
      data={hoverDataFromListItem(ep)}
    />
  );
}

export default function SeasonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { getHex } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("SERIES_EPISODES");
  const { size, setSize, landscapeGridStyle } = useCardSize();
  // The episodes are asked for by this page's id, beside the record — they
  // used to wait for it, to read its show and season — and both are re-read
  // together on every `sync:completed` (new/removed items) without a manual
  // refresh. The Arr/Seerr cards need only the id, so their requests start
  // with them, once per id.
  const { item, playServers, loading, syncTick } = useMediaDetailRecord(id, {
    mediaType: "SERIES",
    plays: false,
    playLinks: PLAY_LINKS,
    refetchOnTick: true,
    children: "episodes",
  });
  const episodeList = useDetailChildren(id, "episodes", syncTick, pickEpisodes);
  const episodes = episodeList.items;
  const [viewMode, handleViewModeChange] = useLocalStorage<"cards" | "table">(
    "season-detail-view-mode",
    "cards",
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

  const openEpisode = useCallback((ep: MediaListItem) => router.push(`/library/series/episode/${ep.id}`), [router]);

  const sortedEpisodes = useMemo(() => {
    const sorted = [...episodes].sort((a, b) => {
      const aVal = a[sortBy as keyof MediaListItem];
      const bVal = b[sortBy as keyof MediaListItem];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal);
      if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
      return String(aVal).localeCompare(String(bVal));
    });
    return sortOrder === "desc" ? sorted.reverse() : sorted;
  }, [episodes, sortBy, sortOrder]);

  // The page renders with its episodes, as it did when it waited for both in turn.
  const pending = loading || (item !== null && !episodeList.loaded);
  if (pending || !item) return <DetailPageStates loading={pending} notFoundLabel="Season not found" />;

  const seriesTitle = item.parentTitle || item.title;
  const seasonNumber = item.seasonNumber ?? 0;
  const seasonLabel = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
  const totalSize = episodes.reduce((sum, ep) => sum + (ep.fileSize ? Number(ep.fileSize) : 0), 0);

  // Quality breakdown, under the standard labels the aggregate routes use
  const qualityCounts: Record<string, number> = {};
  for (const ep of episodes) {
    const label = normalizeResolutionLabel(ep.resolution);
    qualityCounts[label] = (qualityCounts[label] || 0) + 1;
  }

  return (
    <MediaDetailHero
      itemId={item.id}
      imageUrl={`/api/media/${item.id}/image?type=season`}
      title={seriesTitle}
      subtitle={
        <>
          <span>{seasonLabel}</span>
          <span> &middot; {episodes.length} episode{episodes.length !== 1 ? "s" : ""}</span>
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
      genres={genreChips(item.genres)}
      backHref={backOverride?.href ?? `/library/series/show/${item.id}`}
      backLabel={backOverride?.label ?? seriesTitle}
      useParentArt
      playServers={playServers}
    >
      <div className="mt-6">
        <IntegrationsSection itemId={item.id} mediaType="SERIES" hideQualityProfile />
      </div>

      {episodes.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Episodes
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
                <CardDisplayControl prefs={prefs} config={SEASON_EPISODE_TOGGLES} onToggle={setVisible} />
              </>
            )}
          </div>

          {viewMode === "table" ? (
            <MediaTable
              items={sortedEpisodes}
              onItemClick={openEpisode}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="SERIES"
              hideParentTitle
              renderHoverContent={episodeTableHover}
            />
          ) : (
            <div style={landscapeGridStyle}>
              {sortedEpisodes.map((ep) => (
                <MediaCard
                  key={ep.id}
                  imageUrl={`/api/media/${ep.id}/image`}
                  title={ep.episodeNumber != null
                    ? `${formatEpisodeCode(null, ep.episodeNumber)} — ${ep.title}`
                    : ep.title}
                  aspectRatio="landscape"
                  fallbackIcon="series"
                  href={`/library/series/episode/${ep.id}`}
                  prefetchMediaId={ep.id}
                  hoverContent={<MediaHoverPopover summaryUrl={hoverSummaryUrl(ep.id)} data={hoverDataFromListItem(ep)} />}
                  metadata={
                    <MetadataLine stacked>
                      {show("metadata", "episodeLabel") && ep.seasonNumber != null && ep.episodeNumber != null && (
                        <MetadataItem icon={<List />}>{formatEpisodeCode(ep.seasonNumber, ep.episodeNumber)}</MetadataItem>
                      )}
                      {show("metadata", "duration") && formatDuration(ep.duration) && <MetadataItem icon={<Clock />}>{formatDuration(ep.duration)}</MetadataItem>}
                      {show("metadata", "fileSize") && formatFileSize(ep.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(ep.fileSize)}</MetadataItem>}
                    </MetadataLine>
                  }
                  qualityBar={qualitySegments(qualityChips(ep, "video"), getHex, (toggle) => show("badges", toggle))}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {item.parentTitle && (
        <PlayHistory
          seriesKey={item.seriesKey}
          parentTitle={item.parentTitle}
          seasonNumber={seasonNumber}
          heading={`${seasonLabel} Watch History`}
          refreshKey={syncTick}
        />
      )}

      <Separator className="mt-6" />
    </MediaDetailHero>
  );
}
