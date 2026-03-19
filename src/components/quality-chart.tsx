"use client";

import { useState, useEffect } from "react";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { BarChart3, PieChartIcon, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import {
  PieChart,
  Pie,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";

interface QualityChartProps {
  breakdown: {
    resolution: string | null;
    type: string;
    _count: number;
  }[];
  onQualityClick?: (resolution: string) => void;
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  availableTypes?: string[];
}

// Resolution normalization uses shared utility from @/lib/resolution

// Colors are now provided by ChipColorProvider context

type SortedEntry = [string, { movies: number; series: number; music: number }];

function applyTopN(
  sorted: SortedEntry[],
  topN: number | null
): SortedEntry[] {
  if (topN === null || sorted.length <= topN) return sorted;
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const otherMovies = rest.reduce((sum, [, v]) => sum + v.movies, 0);
  const otherSeries = rest.reduce((sum, [, v]) => sum + v.series, 0);
  const otherMusic = rest.reduce((sum, [, v]) => sum + v.music, 0);
  if (otherMovies + otherSeries + otherMusic > 0) {
    const existingOther = top.find(([label]) => label === "Other");
    if (existingOther) {
      existingOther[1].movies += otherMovies;
      existingOther[1].series += otherSeries;
      existingOther[1].music += otherMusic;
    } else {
      top.push(["Other", { movies: otherMovies, series: otherSeries, music: otherMusic }]);
    }
  }
  return top;
}

function PieTooltip({ active, payload }: { active?: boolean; payload?: { name: string; value: number; payload: { pct: number } }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{d.name}</p>
      <p>{d.value.toLocaleString()} ({d.payload.pct.toFixed(1)}%)</p>
    </div>
  );
}

type SortColumn = "label" | "movies" | "series" | "music" | "total" | "count";
type SortDir = "asc" | "desc";

function SortIcon({ column, activeColumn, direction }: { column: SortColumn; activeColumn: SortColumn | null; direction: SortDir }) {
  if (activeColumn !== column) return <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-40" />;
  return direction === "asc"
    ? <ArrowUp className="inline h-3 w-3 ml-1" />
    : <ArrowDown className="inline h-3 w-3 ml-1" />;
}

export function QualityChart({ breakdown, onQualityClick, filterType, lockedFilterType, availableTypes }: QualityChartProps) {
  const { getHex } = useChipColors();
  const [chartType, setChartType] = useState<"bar" | "pie">("bar");
  const [topN, setTopN] = useState<number | null>(5);
  const [tablePage, setTablePage] = useState(0);
  const [localType, setLocalType] = useState<"MOVIE" | "SERIES" | "MUSIC" | undefined>(filterType);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(new Set());

  const toggleHidden = (label: string) => {
    setHiddenItems((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const toggleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDir(col === "label" ? "asc" : "desc");
    }
    setTablePage(0);
  };

  useEffect(() => {
    setLocalType(filterType);
  }, [filterType]);

  const effectiveType = lockedFilterType ? filterType : localType;

  useEffect(() => {
    setTablePage(0);
  }, [topN, effectiveType]);

  // Filter by type if specified
  const filtered = effectiveType
    ? breakdown.filter((item) => item.type === effectiveType)
    : breakdown;

  // Aggregate by normalized resolution
  const aggregated = new Map<string, { movies: number; series: number; music: number }>();

  for (const item of filtered) {
    const label = normalizeResolutionLabel(item.resolution);

    const existing = aggregated.get(label) ?? { movies: 0, series: 0, music: 0 };
    if (item.type === "MOVIE") {
      existing.movies += item._count;
    } else if (item.type === "MUSIC") {
      existing.music += item._count;
    } else {
      existing.series += item._count;
    }
    aggregated.set(label, existing);
  }

  // Sort by quality descending: 4K > 1080p > 720p > 480p > 360p > SD > Other
  const LABEL_ORDER = ["4K", "1080P", "720P", "480P", "SD", "Other"];
  const allSorted: SortedEntry[] = Array.from(aggregated.entries()).sort((a, b) => {
    const aIdx = LABEL_ORDER.indexOf(a[0]);
    const bIdx = LABEL_ORDER.indexOf(b[0]);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  const sorted = applyTopN(allSorted, topN);

  // Sort table items
  const tableSorted = sortColumn
    ? [...allSorted].sort((a, b) => {
        let cmp = 0;
        switch (sortColumn) {
          case "label":
            cmp = a[0].localeCompare(b[0]);
            break;
          case "movies":
            cmp = a[1].movies - b[1].movies;
            break;
          case "series":
            cmp = a[1].series - b[1].series;
            break;
          case "music":
            cmp = a[1].music - b[1].music;
            break;
          case "total":
          case "count":
            cmp = (a[1].movies + a[1].series + a[1].music) - (b[1].movies + b[1].series + b[1].music);
            break;
        }
        return sortDir === "asc" ? cmp : -cmp;
      })
    : allSorted;

  // Table pagination — show ALL items, N per page
  const tablePageSize = topN ?? 10;
  const tableTotalPages = Math.max(1, Math.ceil(tableSorted.length / tablePageSize));
  const tablePageItems = tableSorted.slice(
    tablePage * tablePageSize,
    (tablePage + 1) * tablePageSize
  );

  // Visible items (after toggle filtering)
  const visible = sorted.filter(([label]) => !hiddenItems.has(label));

  const totalMovies = visible.reduce((sum, [, v]) => sum + v.movies, 0);
  const totalSeries = visible.reduce((sum, [, v]) => sum + v.series, 0);
  const totalMusic = visible.reduce((sum, [, v]) => sum + v.music, 0);
  const total = totalMovies + totalSeries + totalMusic;

  const showMusic = !availableTypes || availableTypes.length === 0 || availableTypes.includes("MUSIC");

  // Determine which bars to show
  const bars = effectiveType
    ? effectiveType === "MOVIE"
      ? [{ label: "Movies", key: "movies" as const, total: totalMovies }]
      : effectiveType === "MUSIC"
      ? [{ label: "Music", key: "music" as const, total: totalMusic }]
      : [{ label: "Series", key: "series" as const, total: totalSeries }]
    : [
        { label: "Movies", key: "movies" as const, total: totalMovies },
        { label: "Series", key: "series" as const, total: totalSeries },
        ...(showMusic ? [{ label: "Music", key: "music" as const, total: totalMusic }] : []),
      ];

  if (total === 0) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Quality Breakdown</CardTitle>
            <div className="flex items-center gap-2">
              {!lockedFilterType && (
                <Select
                  value={localType ?? "all"}
                  onValueChange={(v) => setLocalType(v === "all" ? undefined : v as "MOVIE" | "SERIES" | "MUSIC")}
                >
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
                      <SelectItem value="MOVIE">Movies</SelectItem>
                    )}
                    {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
                      <SelectItem value="SERIES">Series</SelectItem>
                    )}
                    {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
                      <SelectItem value="MUSIC">Music</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            No media data yet. Sync a server to see quality breakdown.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Pie chart data
  const pieData = visible.map(([label, counts]) => {
    const count = effectiveType
      ? effectiveType === "MOVIE" ? counts.movies : effectiveType === "MUSIC" ? counts.music : counts.series
      : counts.movies + counts.series + counts.music;
    return { name: label, value: count, pct: total > 0 ? (count / total) * 100 : 0, fill: getHex("resolution", label) };
  }).filter((d) => d.value > 0);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle>Quality Breakdown</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {!lockedFilterType && (
              <Select
                value={localType ?? "all"}
                onValueChange={(v) => setLocalType(v === "all" ? undefined : v as "MOVIE" | "SERIES" | "MUSIC")}
              >
                <SelectTrigger className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MOVIE")) && (
                    <SelectItem value="MOVIE">Movies</SelectItem>
                  )}
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("SERIES")) && (
                    <SelectItem value="SERIES">Series</SelectItem>
                  )}
                  {(!availableTypes || availableTypes.length === 0 || availableTypes.includes("MUSIC")) && (
                    <SelectItem value="MUSIC">Music</SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}
            <Select
              value={topN === null ? "all" : String(topN)}
              onValueChange={(v) => setTopN(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="h-7 w-22 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">Top 5</SelectItem>
                <SelectItem value="10">Top 10</SelectItem>
                <SelectItem value="15">Top 15</SelectItem>
                <SelectItem value="20">Top 20</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex rounded-md border">
              <Button
                variant={chartType === "bar" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7 rounded-r-none"
                onClick={() => setChartType("bar")}
              >
                <BarChart3 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={chartType === "pie" ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7 rounded-l-none"
                onClick={() => setChartType("pie")}
              >
                <PieChartIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto flex flex-col">
        {chartType === "bar" ? (
          /* Bar visualizations */
          <TooltipProvider>
          <div className="mb-6 space-y-3">
            {bars.map(({ label: typeLabel, key, total: typeTotal }) => (
              <div key={key}>
                {!effectiveType && (
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {typeLabel}
                  </p>
                )}
                <div className="flex h-3.5 overflow-hidden rounded-full">
                  {typeTotal === 0 ? (
                    <div className="h-full w-full bg-muted" />
                  ) : (
                    visible.map(([label, counts]) => {
                      const count = counts[key];
                      const pct = (count / typeTotal) * 100;
                      if (pct === 0) return null;
                      return (
                        <Tooltip key={label}>
                          <TooltipTrigger asChild>
                            <div
                              className={`transition-all ${onQualityClick ? "cursor-pointer hover:opacity-80" : ""}`}
                              style={{ width: `${pct}%`, backgroundColor: getHex("resolution", label) }}
                              onClick={onQualityClick ? () => onQualityClick(label) : undefined}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p className="font-medium">{label}</p>
                            <p>{count.toLocaleString()} ({pct.toFixed(1)}%)</p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
          </TooltipProvider>
        ) : (
          /* Pie chart */
          <div className="mb-6 flex flex-1 min-h-48 justify-center">
            <div className="w-full max-w-xs">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius="80%"
                    innerRadius="30%"
                  />
                  <RechartsTooltip content={<PieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Legend — click to toggle visibility */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {sorted.map(([label, counts]) => {
            const isHidden = hiddenItems.has(label);
            const count = effectiveType
              ? effectiveType === "MOVIE" ? counts.movies : effectiveType === "MUSIC" ? counts.music : counts.series
              : counts.movies + counts.series + counts.music;
            return (
              <div
                key={label}
                className={`flex items-center gap-2 cursor-pointer select-none transition-opacity ${isHidden ? "opacity-35" : "hover:opacity-80"}`}
                onClick={() => toggleHidden(label)}
              >
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: isHidden ? "#6b7280" : getHex("resolution", label) }}
                />
                <div>
                  <p className={`text-sm font-medium ${isHidden ? "line-through" : ""}`}>{label}</p>
                  <p className="text-xs text-muted-foreground">
                    {count.toLocaleString()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detailed table */}
        <div className="mt-6 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("label")}>
                  Resolution
                  <SortIcon column="label" activeColumn={sortColumn} direction={sortDir} />
                </th>
                {effectiveType ? (
                  <th className="px-4 py-2 text-right font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("count")}>
                    Count
                    <SortIcon column="count" activeColumn={sortColumn} direction={sortDir} />
                  </th>
                ) : (
                  <>
                    <th className="px-4 py-2 text-right font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("movies")}>
                      Movies
                      <SortIcon column="movies" activeColumn={sortColumn} direction={sortDir} />
                    </th>
                    <th className="px-4 py-2 text-right font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("series")}>
                      Series
                      <SortIcon column="series" activeColumn={sortColumn} direction={sortDir} />
                    </th>
                    {showMusic && (
                      <th className="px-4 py-2 text-right font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("music")}>
                        Music
                        <SortIcon column="music" activeColumn={sortColumn} direction={sortDir} />
                      </th>
                    )}
                    <th className="px-4 py-2 text-right font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("total")}>
                      Total
                      <SortIcon column="total" activeColumn={sortColumn} direction={sortDir} />
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tablePageItems.map(([label, counts]) => (
                <tr
                  key={label}
                  className={`border-b last:border-0 ${onQualityClick ? "cursor-pointer hover:bg-muted/50" : ""}`}
                  onClick={onQualityClick ? () => onQualityClick(label) : undefined}
                >
                  <td className="px-4 py-2 flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: getHex("resolution", label) }}
                    />
                    {label}
                  </td>
                  {effectiveType ? (
                    <td className="px-4 py-2 text-right font-medium">
                      {(effectiveType === "MOVIE" ? counts.movies : effectiveType === "MUSIC" ? counts.music : counts.series).toLocaleString()}
                    </td>
                  ) : (
                    <>
                      <td className="px-4 py-2 text-right">
                        {counts.movies.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {counts.series.toLocaleString()}
                      </td>
                      {showMusic && (
                        <td className="px-4 py-2 text-right">
                          {counts.music.toLocaleString()}
                        </td>
                      )}
                      <td className="px-4 py-2 text-right font-medium">
                        {(counts.movies + counts.series + (showMusic ? counts.music : 0)).toLocaleString()}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {tableTotalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-muted-foreground">
              {tablePage * tablePageSize + 1}&ndash;{Math.min((tablePage + 1) * tablePageSize, tableSorted.length)} of {tableSorted.length}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={tablePage === 0}
                onClick={() => setTablePage(tablePage - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {Array.from({ length: tableTotalPages }, (_, i) => (
                <Button
                  key={i}
                  variant={i === tablePage ? "default" : "ghost"}
                  size="icon"
                  className="h-7 w-7 text-xs"
                  onClick={() => setTablePage(i)}
                >
                  {i + 1}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={tablePage >= tableTotalPages - 1}
                onClick={() => setTablePage(tablePage + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
