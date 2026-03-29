"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useChipColors } from "@/components/chip-color-provider";
import { MediaCard } from "@/components/media-card";
import { MediaFilters } from "@/components/media-filters";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table";
import type { DataTableColumn } from "@/components/data-table";
import { LibraryToolbar } from "@/components/library-toolbar";
import { Tv, Layers, List, HardDrive, Play } from "lucide-react";
import Link from "next/link";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { formatFileSize } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { MediaGridSkeleton } from "@/components/skeletons";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

interface SeasonEntry {
  parentTitle: string;
  seasonNumber: number;
  mediaItemId: string;
  episodeCount: number;
  totalSize: string;
  lastPlayed: string | null;
  addedAt: string | null;
  totalPlayCount: number;
  qualityCounts: Record<string, number>;
}

const QUALITY_ORDER = ["4K", "1080P", "720P", "480P", "SD", "Other"];

const SORT_OPTIONS = [
  { value: "parentTitle", label: "Series Name" },
  { value: "seasonNumber", label: "Season Number" },
  { value: "episodeCount", label: "Episodes" },
  { value: "totalSize", label: "Size" },
  { value: "lastPlayed", label: "Last Watched" },
  { value: "addedAt", label: "Date Added" },
];

function seasonTableColumns(
  getSolidStyle: (category: "resolution" | "dynamicRange" | "audioProfile", value: string) => React.CSSProperties
): DataTableColumn<SeasonEntry>[] {
  return [
    {
      id: "parentTitle",
      header: "Series",
      defaultWidth: 250,
      accessor: (s) => s.parentTitle,
      sortValue: (s) => s.parentTitle,
      sortable: true,
    },
    {
      id: "seasonNumber",
      header: "Season",
      defaultWidth: 110,
      accessor: (s) => s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`,
      sortValue: (s) => s.seasonNumber,
      sortable: true,
    },
    {
      id: "episodeCount",
      header: "Episodes",
      defaultWidth: 90,
      accessor: (s) => s.episodeCount,
      sortValue: (s) => s.episodeCount,
      sortable: true,
      className: "text-right",
      headerClassName: "text-right",
    },
    {
      id: "totalSize",
      header: "Size",
      defaultWidth: 100,
      accessor: (s) => formatFileSize(s.totalSize),
      sortValue: (s) => Number(s.totalSize),
      sortable: true,
      className: "text-right",
      headerClassName: "text-right",
    },
    {
      id: "quality",
      header: "Quality",
      defaultWidth: 200,
      accessor: (s) => {
        const qualities = QUALITY_ORDER.filter((q) => s.qualityCounts[q]);
        if (qualities.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1">
            {qualities.map((q) => (
              <Badge
                key={q}
                className="text-[10px] px-1.5 py-0"
                style={getSolidStyle("resolution", q)}
              >
                {q}: {s.qualityCounts[q]}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      id: "totalPlayCount",
      header: "Plays",
      defaultWidth: 80,
      accessor: (s) => s.totalPlayCount || "—",
      sortValue: (s) => s.totalPlayCount,
      sortable: true,
      className: "text-right",
      headerClassName: "text-right",
    },
    {
      id: "lastPlayed",
      header: "Last Watched",
      defaultWidth: 120,
      accessor: (s) =>
        s.lastPlayed ? new Date(s.lastPlayed).toLocaleDateString() : "—",
      sortValue: (s) =>
        s.lastPlayed ? new Date(s.lastPlayed).getTime() : 0,
      sortable: true,
    },
    {
      id: "addedAt",
      header: "Added",
      defaultWidth: 100,
      accessor: (s) =>
        s.addedAt ? new Date(s.addedAt).toLocaleDateString() : "—",
      sortValue: (s) =>
        s.addedAt ? new Date(s.addedAt).getTime() : 0,
      sortable: true,
    },
  ];
}

export default function AllSeasonsPage() {
  const router = useRouter();
  const { getSolidStyle } = useChipColors();
  const { show, setVisible, prefs } = useCardDisplay("SERIES_SEASONS");
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState("parentTitle");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");

  const { size, setSize, gridStyle } = useCardSize();

  const { markChildNavigation } = useScrollRestoration("/library/series/seasons", !loading && seasons.length > 0);

  useEffect(() => {
    const stored = localStorage.getItem("seasons-view-mode") as "cards" | "table" | null;
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: "cards" | "table") => {
    setViewMode(mode);
    localStorage.setItem("seasons-view-mode", mode);
  };

  const fetchSeasons = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const response = await fetch(`/api/media/series/all-seasons?${params}`);
      const data = await response.json();
      setSeasons(data.seasons || []);
    } catch (error) {
      console.error("Failed to fetch seasons:", error);
    } finally {
      setLoading(false);
    }
  }, [filters, sortBy, sortOrder]);

  useEffect(() => {
    const timeout = setTimeout(() => fetchSeasons(), 300);
    return () => clearTimeout(timeout);
  }, [fetchSeasons]);

  const toggleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  const navigateToSeason = (season: SeasonEntry) => {
    markChildNavigation();
    router.push(`/library/series/season/${season.mediaItemId}`);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight mb-4">Series</h1>

      <nav className="mb-6 flex items-center gap-1 border-b overflow-x-auto">
        <Link
          href="/library/series"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <Tv className="h-4 w-4" />
          Series
        </Link>
        <Link
          href="/library/series/seasons"
          className="flex items-center gap-2 border-b-2 border-primary px-4 py-2 text-sm font-medium text-foreground"
        >
          <Layers className="h-4 w-4" />
          All Seasons
        </Link>
        <Link
          href="/library/series/episodes"
          className="flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/30 transition-colors"
        >
          <List className="h-4 w-4" />
          All Episodes
        </Link>
      </nav>

      <MediaFilters
        onFilterChange={setFilters}
        mediaType="SERIES"
        prefix={
          <LibraryToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            cardSize={size}
            onCardSizeChange={setSize}
            cardDisplayPrefs={prefs}
            cardDisplayConfig={TOGGLE_CONFIGS.SERIES_SEASONS}
            onCardDisplayToggle={setVisible}
            sortOptions={SORT_OPTIONS}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={(v) => toggleSort(v)}
            onSortOrderToggle={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
          />
        }
      />

      {loading ? (
        <MediaGridSkeleton />
      ) : seasons.length === 0 ? (
        <EmptyState icon={Tv} title="No seasons found." />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {seasons.length} {seasons.length === 1 ? "season" : "seasons"}
          </p>

          {viewMode === "table" ? (
            <DataTable<SeasonEntry>
              columns={seasonTableColumns(getSolidStyle)}
              data={seasons}
              keyExtractor={(s) => `${s.parentTitle}::${s.seasonNumber}`}
              defaultSortId="parentTitle"
              resizeStorageKey="dt-widths-seasons"
              onRowClick={navigateToSeason}
            />
          ) : (
            <>
              <div style={gridStyle}>
                {seasons.map((season) => (
                  <MediaCard
                    key={`${season.parentTitle}::${season.seasonNumber}`}
                    imageUrl={`/api/media/${season.mediaItemId}/image?type=season`}
                    title={`${season.parentTitle} — ${season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`}`}
                    fallbackIcon="series"
                    onClick={() => navigateToSeason(season)}
                    metadata={
                      <MetadataLine stacked>
                        {show("metadata", "episodeCount") && <MetadataItem icon={<List />}>{season.episodeCount} {season.episodeCount === 1 ? "ep" : "eps"}</MetadataItem>}
                        {show("metadata", "fileSize") && <MetadataItem icon={<HardDrive />}>{formatFileSize(season.totalSize)}</MetadataItem>}
                        {show("metadata", "playCount") && season.totalPlayCount > 0 && (
                          <MetadataItem icon={<Play />}>{season.totalPlayCount} {season.totalPlayCount === 1 ? "play" : "plays"}</MetadataItem>
                        )}
                      </MetadataLine>
                    }
                    badges={
                      <>
                        {show("badges", "qualityCounts") && QUALITY_ORDER.filter(
                          (q) => season.qualityCounts[q]
                        ).map((quality) => (
                          <Badge
                            key={quality}
                            className="text-[10px] px-1.5 py-0"
                            style={getSolidStyle("resolution", quality)}
                          >
                            {quality}: {season.qualityCounts[quality]}
                          </Badge>
                        ))}
                      </>
                    }
                  />
                ))}
              </div>

            </>
          )}
        </>
      )}
    </div>
  );
}
