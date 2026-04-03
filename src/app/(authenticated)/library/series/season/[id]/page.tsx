"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel, QUALITY_ORDER } from "@/lib/resolution";
import { cn } from "@/lib/utils";
import { MediaDetailHero } from "@/components/media-detail-hero";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { LayoutGrid, TableProperties, List, Clock, HardDrive } from "lucide-react";
import { formatFileSize, formatDuration } from "@/lib/format";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import type { MediaItemWithRelations } from "@/lib/types";
import { type PlayServer, buildPlayLinks } from "@/lib/play-url";
import { ArrSection } from "@/components/arr-link-button";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "Unknown";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

export default function SeasonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { getBadgeStyle, getSolidStyle } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("SERIES_EPISODES");
  const { size, setSize, landscapeGridStyle } = useCardSize();
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [episodes, setEpisodes] = useState<MediaItemWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [sortBy, setSortBy] = useState("episodeNumber");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    const stored = localStorage.getItem("season-detail-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("season-detail-view-mode", mode);
  };

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

  useEffect(() => {
    async function fetchData() {
      try {
        const itemRes = await fetch(`/api/media/${id}`);
        const itemData = await itemRes.json();
        if (!itemData.item) return;
        setItem(itemData.item);
        setPlayServers(buildPlayLinks(itemData.playServers || [], [
          ["Season", "parentRatingKey"],
          ["Series", "grandparentRatingKey"],
          ["Episode", "ratingKey"],
        ]));

        const parentTitle = itemData.item.parentTitle;
        const seasonNumber = itemData.item.seasonNumber ?? 0;
        if (!parentTitle) return;

        const episodesRes = await fetch(
          `/api/media/series?parentTitle=${encodeURIComponent(parentTitle)}&seasonNumber=${seasonNumber}&sortBy=episodeNumber&sortOrder=asc&limit=0`
        );
        const episodesData = await episodesRes.json();
        setEpisodes(episodesData.items || []);
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  const sortedEpisodes = useMemo(() => {
    const sorted = [...episodes].sort((a, b) => {
      const aVal = a[sortBy as keyof MediaItemWithRelations];
      const bVal = b[sortBy as keyof MediaItemWithRelations];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal);
      if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
      return String(aVal).localeCompare(String(bVal));
    });
    return sortOrder === "desc" ? sorted.reverse() : sorted;
  }, [episodes, sortBy, sortOrder]);

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
        <p className="text-muted-foreground">Season not found</p>
      </div>
    );
  }

  const seriesTitle = item.parentTitle || item.title;
  const seasonNumber = item.seasonNumber ?? 0;
  const seasonLabel = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
  const totalSize = episodes.reduce((sum, ep) => sum + (ep.fileSize ? Number(ep.fileSize) : 0), 0);

  // Quality breakdown (normalize to standard labels so QUALITY_ORDER works)
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
          {QUALITY_ORDER
            .filter((q) => qualityCounts[q])
            .map((label) => (
              <Badge key={label} variant="secondary" style={getBadgeStyle("resolution", label)}>
                {label}: {qualityCounts[label]}
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
      backHref={`/library/series/show/${item.id}`}
      backLabel={seriesTitle}
      useParentArt
      playServers={playServers}
    >
      <div className="mt-6">
        <ArrSection itemId={item.id} mediaType="SERIES" hideQualityProfile />
      </div>

      {episodes.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-center gap-3">
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
                <CardDisplayControl prefs={prefs} config={TOGGLE_CONFIGS.SERIES_EPISODES} onToggle={setVisible} />
              </>
            )}
          </div>

          {viewMode === "table" ? (
            <MediaTable
              items={sortedEpisodes}
              onItemClick={(ep) => router.push(`/library/series/episode/${ep.id}`)}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              mediaType="SERIES"
              hideParentTitle
            />
          ) : (
            <div style={landscapeGridStyle}>
              {sortedEpisodes.map((ep) => (
                <MediaCard
                  key={ep.id}
                  imageUrl={`/api/media/${ep.id}/image`}
                  title={ep.episodeNumber != null
                    ? `E${String(ep.episodeNumber).padStart(2, "0")} — ${ep.title}`
                    : ep.title}
                  aspectRatio="landscape"
                  fallbackIcon="series"
                  onClick={() => router.push(`/library/series/episode/${ep.id}`)}
                  metadata={
                    <MetadataLine stacked>
                      {show("metadata", "episodeLabel") && ep.seasonNumber != null && ep.episodeNumber != null && (
                        <MetadataItem icon={<List />}>S{String(ep.seasonNumber).padStart(2, "0")}E{String(ep.episodeNumber).padStart(2, "0")}</MetadataItem>
                      )}
                      {show("metadata", "duration") && formatDuration(ep.duration) && <MetadataItem icon={<Clock />}>{formatDuration(ep.duration)}</MetadataItem>}
                      {show("metadata", "fileSize") && formatFileSize(ep.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(ep.fileSize)}</MetadataItem>}
                    </MetadataLine>
                  }
                  badges={
                    <>
                      {show("badges", "resolution") && ep.resolution && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("resolution", formatResolution(ep.resolution))}
                        >
                          {formatResolution(ep.resolution)}
                        </Badge>
                      )}
                      {show("badges", "dynamicRange") && ep.dynamicRange && ep.dynamicRange !== "SDR" && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("dynamicRange", ep.dynamicRange)}
                        >
                          {ep.dynamicRange}
                        </Badge>
                      )}
                      {show("badges", "audioProfile") && ep.audioProfile && (
                        <Badge
                          className="text-[10px] px-1.5 py-0"
                          style={getSolidStyle("audioProfile", ep.audioProfile)}
                        >
                          {ep.audioProfile}
                        </Badge>
                      )}
                    </>
                  }
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
