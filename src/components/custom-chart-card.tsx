"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Settings2 } from "lucide-react";
import {
  PieChart,
  Pie,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  RadarChart,
  Radar,
  Treemap,
  PolarGrid,
  PolarAngleAxis,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import { getDimensionMeta } from "@/lib/dashboard/custom-dimensions";
import { HEATMAP_GRADIENTS, type CustomCardConfig } from "@/lib/dashboard/card-registry";
import { useChipColors } from "@/components/chip-color-provider";
import type { ChipColorCategory } from "@/lib/theme/chip-colors";

const AUTO_HEX = [
  "#3b82f6", "#a855f7", "#22c55e", "#f59e0b", "#ef4444",
  "#06b6d4", "#ec4899", "#f97316", "#14b8a6", "#6366f1",
  "#84cc16", "#f43f5e", "#0ea5e9", "#8b5cf6", "#d946ef",
];

const OTHER_HEX = "#6e7383";

const DIMENSION_CHIP_CATEGORY: Partial<Record<string, ChipColorCategory>> = {
  resolution: "resolution",
  dynamicRange: "dynamicRange",
  audioProfile: "audioProfile",
};

function interpolateHex(low: string, high: string, t: number): string {
  const lr = parseInt(low.slice(1, 3), 16);
  const lg = parseInt(low.slice(3, 5), 16);
  const lb = parseInt(low.slice(5, 7), 16);
  const hr = parseInt(high.slice(1, 3), 16);
  const hg = parseInt(high.slice(3, 5), 16);
  const hb = parseInt(high.slice(5, 7), 16);
  const r = Math.round(lr + (hr - lr) * t);
  const g = Math.round(lg + (hg - lg) * t);
  const b = Math.round(lb + (hb - lb) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function getGradientColors(gradientId?: string) {
  const preset = HEATMAP_GRADIENTS.find((g) => g.id === gradientId) ?? HEATMAP_GRADIENTS[0];
  return { low: preset.low, high: preset.high };
}

type BreakdownRow = { value: string | null; type: string; _count: number };
type AggregatedEntry = { label: string; count: number; movies: number; series: number; music: number };
type CrossTabRow = { dim1: string | null; dim2: string | null; type: string; _count: number };
type TimelinePoint = { date: string; total: number; breakdown?: Record<string, number> };
type TimelineData = { points: TimelinePoint[]; series: string[] };

interface HeatmapCell {
  dim1: string;
  dim2: string;
  count: number;
}

interface HeatmapData {
  cells: HeatmapCell[];
  dim1Labels: string[];
  dim2Labels: string[];
  maxCount: number;
}

interface CustomChartCardProps {
  config: CustomCardConfig;
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  serverId?: string;
  availableTypes?: string[];
  onEditConfig?: (config: CustomCardConfig) => void;
}

export function CustomChartCard({
  config,
  filterType: externalFilterType,
  lockedFilterType,
  serverId,
  availableTypes,
  onEditConfig,
}: CustomChartCardProps) {
  const { getHex } = useChipColors();
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [heatmapRaw, setHeatmapRaw] = useState<CrossTabRow[]>([]);
  const [timelineData, setTimelineData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [localFilter, setLocalFilter] = useState<string>("ALL");
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(new Set());

  const isHeatmap = config.chartType === "heatmap";
  const isCount = config.chartType === "count";
  const isTimeline = config.chartType === "timeline";

  const toggleHidden = (label: string) => {
    setHiddenItems((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const filterType = lockedFilterType ? externalFilterType : (localFilter === "ALL" ? undefined : localFilter);

  const meta = getDimensionMeta(config.dimension);
  const meta2 = config.dimension2 ? getDimensionMeta(config.dimension2) : null;
  const cardTitle = config.title || (
    isTimeline && meta && meta2
      ? `${meta.label} by ${meta2.label}`
      : isTimeline && meta ? `${meta.label} Timeline`
      : isHeatmap && meta && meta2
      ? `${meta.label} vs ${meta2.label}`
      : isCount && meta ? `${meta.label} Count`
      : meta ? `${meta.label} Breakdown` : "Custom Chart"
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (isTimeline) {
        const params = new URLSearchParams({ dateField: config.dimension, bin: config.timelineBin ?? "month" });
        if (config.dimension2) params.set("breakdown", config.dimension2);
        if (config.topN !== undefined && config.topN !== null) params.set("topN", String(config.topN));
        if (serverId) params.set("serverId", serverId);
        if (filterType) params.set("type", filterType as string);
        const res = await fetch(`/api/media/stats/timeline?${params}`);
        if (res.ok) {
          const data = await res.json();
          setTimelineData(data);
        }
      } else if (isHeatmap && config.dimension2) {
        const params = new URLSearchParams({
          dimension1: config.dimension,
          dimension2: config.dimension2,
        });
        if (serverId) params.set("serverId", serverId);
        const res = await fetch(`/api/media/stats/cross-tab?${params}`);
        if (res.ok) {
          const data = await res.json();
          setHeatmapRaw(data.rows ?? []);
        }
      } else {
        const params = new URLSearchParams({ dimension: config.dimension });
        if (serverId) params.set("serverId", serverId);
        const res = await fetch(`/api/media/stats/custom?${params}`);
        if (res.ok) {
          const data = await res.json();
          setBreakdown(data.breakdown ?? []);
        }
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [config.dimension, config.dimension2, config.timelineBin, config.topN, isHeatmap, isTimeline, serverId, filterType]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Heatmap data processing
  const heatmapData = useMemo(() => {
    if (!isHeatmap) return null;
    return processHeatmapData(
      heatmapRaw,
      filterType,
      config.topN !== undefined ? config.topN : 10,
      meta?.nullLabel ?? "Unknown",
      meta2?.nullLabel ?? "Unknown",
    );
  }, [isHeatmap, heatmapRaw, filterType, config.topN, meta?.nullLabel, meta2?.nullLabel]);

  // Standard chart data (non-heatmap)
  const aggregated = !isHeatmap ? aggregateBreakdown(breakdown, filterType, meta?.nullLabel ?? "Unknown") : [];
  const sorted = aggregated.sort((a, b) => b.count - a.count);
  const topN = config.topN !== undefined ? config.topN : 10;
  const displayed = applyTopN(sorted, topN);
  const chipCategory = DIMENSION_CHIP_CATEGORY[config.dimension];
  const allWithColors = displayed.map((entry, i) => ({
    ...entry,
    fill: entry.label === "Other"
      ? OTHER_HEX
      : chipCategory
        ? getHex(chipCategory, entry.label)
        : AUTO_HEX[i % AUTO_HEX.length],
  }));
  const chartData = allWithColors.filter((entry) => !hiddenItems.has(entry.label));

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-semibold">{cardTitle}</CardTitle>
        <div className="flex items-center gap-2">
          {/* Type filter (only if not locked) */}
          {!lockedFilterType && availableTypes && availableTypes.length > 1 && (
            <Select value={localFilter} onValueChange={setLocalFilter}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                {availableTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === "MOVIE" ? "Movies" : t === "SERIES" ? "Series" : "Music"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* Edit config button */}
          {onEditConfig && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEditConfig(config)}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : isCount ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-5xl font-bold">
              {allWithColors
                .filter((e) => !config.countValues?.length || config.countValues.includes(e.label))
                .reduce((sum, e) => sum + e.count, 0)
                .toLocaleString()}
            </span>
          </div>
        ) : isHeatmap ? (
          heatmapData && heatmapData.cells.length > 0 ? (
            <>
              <HeatmapChart data={heatmapData} gradientId={config.heatmapGradient} />
              {/* Gradient legend */}
              {(() => {
                const { low, high } = getGradientColors(config.heatmapGradient);
                return (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Low</span>
                    <div
                      className="h-2.5 flex-1 rounded-full"
                      style={{ background: `linear-gradient(to right, ${low}1a, ${high})` }}
                    />
                    <span>High</span>
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              No data available
            </div>
          )
        ) : isTimeline ? (
          timelineData && timelineData.points.length > 0 ? (
            <>
              <TimelineChart data={timelineData} hiddenItems={hiddenItems} />
              {timelineData.series.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                  {timelineData.series.map((label, i) => {
                    const isHidden = hiddenItems.has(label);
                    const color = label === "Other" ? OTHER_HEX : AUTO_HEX[i % AUTO_HEX.length];
                    return (
                      <div
                        key={label}
                        className={`flex items-center gap-1.5 cursor-pointer select-none transition-opacity ${isHidden ? "opacity-35" : "hover:opacity-80"}`}
                        onClick={() => toggleHidden(label)}
                      >
                        <div
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: isHidden ? "#6e7383" : color }}
                        />
                        <span className={`text-xs ${isHidden ? "line-through text-muted-foreground" : ""}`}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              No data available
            </div>
          )
        ) : allWithColors.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No data available
          </div>
        ) : (
          <>
            <div className="min-h-48 flex-1">
              {renderChart(config.chartType, chartData)}
            </div>
            {/* Legend — click to toggle visibility */}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {allWithColors.map((entry) => {
                const isHidden = hiddenItems.has(entry.label);
                return (
                  <div
                    key={entry.label}
                    className={`flex items-center gap-1.5 cursor-pointer select-none transition-opacity ${isHidden ? "opacity-35" : "hover:opacity-80"}`}
                    onClick={() => toggleHidden(entry.label)}
                  >
                    <div
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: isHidden ? "#6e7383" : entry.fill }}
                    />
                    <span className={`text-xs ${isHidden ? "line-through text-muted-foreground" : ""}`}>
                      {entry.label} ({entry.count.toLocaleString()})
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Data helpers ──────────────────────────────────────────────────

function aggregateBreakdown(
  rows: BreakdownRow[],
  filterType: string | undefined,
  nullLabel: string
): AggregatedEntry[] {
  const map = new Map<string, { movies: number; series: number; music: number }>();

  for (const row of rows) {
    if (filterType && row.type !== filterType) continue;
    const label = row.value ?? nullLabel;
    const existing = map.get(label) ?? { movies: 0, series: 0, music: 0 };
    if (row.type === "MOVIE") existing.movies += row._count;
    else if (row.type === "SERIES") existing.series += row._count;
    else if (row.type === "MUSIC") existing.music += row._count;
    map.set(label, existing);
  }

  return Array.from(map.entries()).map(([label, counts]) => ({
    label,
    count: counts.movies + counts.series + counts.music,
    ...counts,
  }));
}

function applyTopN(sorted: AggregatedEntry[], topN: number | null): AggregatedEntry[] {
  if (topN === null || sorted.length <= topN) return sorted;
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const otherCount = rest.reduce((sum, e) => sum + e.count, 0);
  if (otherCount > 0) {
    top.push({
      label: "Other",
      count: otherCount,
      movies: rest.reduce((sum, e) => sum + e.movies, 0),
      series: rest.reduce((sum, e) => sum + e.series, 0),
      music: rest.reduce((sum, e) => sum + e.music, 0),
    });
  }
  return top;
}

function processHeatmapData(
  rows: CrossTabRow[],
  filterType: string | undefined,
  topN: number | null,
  nullLabel1: string,
  nullLabel2: string,
): HeatmapData | null {
  const filtered = filterType ? rows.filter((r) => r.type === filterType) : rows;
  if (filtered.length === 0) return null;

  // Aggregate across types
  const cellMap = new Map<string, number>();
  for (const row of filtered) {
    const d1 = row.dim1 ?? nullLabel1;
    const d2 = row.dim2 ?? nullLabel2;
    const key = `${d1}\0${d2}`;
    cellMap.set(key, (cellMap.get(key) ?? 0) + row._count);
  }

  // Per-axis totals for topN ranking
  const dim1Totals = new Map<string, number>();
  const dim2Totals = new Map<string, number>();
  for (const [key, count] of cellMap) {
    const [d1, d2] = key.split("\0");
    dim1Totals.set(d1, (dim1Totals.get(d1) ?? 0) + count);
    dim2Totals.set(d2, (dim2Totals.get(d2) ?? 0) + count);
  }

  let dim1Labels = [...dim1Totals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  let dim2Labels = [...dim2Totals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

  if (topN !== null) {
    dim1Labels = dim1Labels.slice(0, topN);
    dim2Labels = dim2Labels.slice(0, topN);
  }

  const dim1Set = new Set(dim1Labels);
  const dim2Set = new Set(dim2Labels);
  const cells: HeatmapCell[] = [];
  let maxCount = 0;

  for (const [key, count] of cellMap) {
    const [d1, d2] = key.split("\0");
    if (!dim1Set.has(d1) || !dim2Set.has(d2)) continue;
    cells.push({ dim1: d1, dim2: d2, count });
    if (count > maxCount) maxCount = count;
  }

  return { cells, dim1Labels, dim2Labels, maxCount };
}

// ── Tooltip ──────────────────────────────────────────────────────

type ChartDatum = AggregatedEntry & { fill: string };

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: Record<string, unknown> }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;

  // Treemap data shape: { name, size, fill }
  if ("name" in d && "size" in d && !("label" in d)) {
    return (
      <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
        <p className="font-medium">{String(d.name)}</p>
        <p className="text-muted-foreground">{Number(d.size).toLocaleString()} items</p>
      </div>
    );
  }

  // Standard data shape: { label, count }
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{String(d.label)}</p>
      <p className="text-muted-foreground">{Number(d.count).toLocaleString()} items</p>
    </div>
  );
}

// ── Treemap cell content ─────────────────────────────────────────

function TreemapCell(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  fill?: string;
}) {
  const { x = 0, y = 0, width = 0, height = 0, name, fill } = props;
  if (width < 4 || height < 4) return null;

  const maxChars = Math.max(3, Math.floor(width / 7));
  const displayName = name && name.length > maxChars ? name.slice(0, maxChars - 1) + "\u2026" : name;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={3}
        fill={fill}
        stroke="var(--card)"
        strokeWidth={2}
      />
      {width > 36 && height > 18 && (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={Math.min(12, Math.max(9, width / 10))}
          fontWeight={500}
          style={{ pointerEvents: "none" }}
        >
          {displayName}
        </text>
      )}
    </g>
  );
}

// ── Heatmap chart (custom SVG) ───────────────────────────────────

function HeatmapChart({ data, gradientId }: { data: HeatmapData; gradientId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    dim1: string;
    dim2: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { low, high } = getGradientColors(gradientId);

  const labelPadLeft = 90;
  const labelPadBottom = 60;
  const minCellSize = 20;
  const maxCellSize = 44;

  // Compute cellSize: expand to fill card width when few items
  const availableWidth = containerWidth - labelPadLeft;
  const naturalCellSize = availableWidth > 0 && data.dim1Labels.length > 0
    ? Math.floor(availableWidth / data.dim1Labels.length)
    : 26;
  const cellSize = Math.max(minCellSize, Math.min(maxCellSize, naturalCellSize));

  const gridW = data.dim1Labels.length * cellSize;
  const gridH = data.dim2Labels.length * cellSize;
  const svgW = labelPadLeft + gridW;
  const svgH = gridH + labelPadBottom;

  const cellLookup = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of data.cells) {
      map.set(`${cell.dim1}\0${cell.dim2}`, cell.count);
    }
    return map;
  }, [data.cells]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, dim1: string, dim2: string, count: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        dim1,
        dim2,
        count,
      });
    },
    [],
  );

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <div ref={containerRef} className="relative min-h-48 flex-1 overflow-auto">
      {containerWidth > 0 && (
        <svg width={svgW} height={svgH}>
          {/* Y-axis labels (dim2) */}
          {data.dim2Labels.map((label, yi) => (
            <text
              key={`y-${yi}`}
              x={labelPadLeft - 6}
              y={yi * cellSize + cellSize / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-muted-foreground"
              fontSize={10}
            >
              {label.length > 11 ? label.slice(0, 10) + "\u2026" : label}
            </text>
          ))}

          {/* Grid cells */}
          {data.dim2Labels.map((d2, yi) =>
            data.dim1Labels.map((d1, xi) => {
              const count = cellLookup.get(`${d1}\0${d2}`) ?? 0;
              const t = data.maxCount > 0 ? count / data.maxCount : 0;

              return (
                <rect
                  key={`${xi}-${yi}`}
                  x={labelPadLeft + xi * cellSize}
                  y={yi * cellSize}
                  width={cellSize - 2}
                  height={cellSize - 2}
                  rx={3}
                  fill={count > 0 ? interpolateHex(low, high, t) : "#555"}
                  opacity={count > 0 ? 1 : 0.08}
                  onMouseMove={(e) => handleMouseMove(e, d1, d2, count)}
                  onMouseLeave={handleMouseLeave}
                />
              );
            }),
          )}

          {/* X-axis labels (dim1) */}
          {data.dim1Labels.map((label, xi) => (
            <text
              key={`x-${xi}`}
              x={labelPadLeft + xi * cellSize + cellSize / 2}
              y={gridH + 8}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={10}
              transform={`rotate(-45, ${labelPadLeft + xi * cellSize + cellSize / 2}, ${gridH + 8})`}
            >
              {label.length > 11 ? label.slice(0, 10) + "\u2026" : label}
            </text>
          ))}
        </svg>
      )}

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-sm shadow-md"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <p className="font-medium whitespace-nowrap">
            {tooltip.dim1} &times; {tooltip.dim2}
          </p>
          <p className="text-muted-foreground">{tooltip.count.toLocaleString()} items</p>
        </div>
      )}
    </div>
  );
}

// ── Pan-enabled range slider ─────────────────────────────────────

function PanSlider({ value, onChange }: { value: [number, number]; onChange: (v: [number, number]) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startRange: [number, number]; mode: "left" | "right" | "pan" } | null>(null);

  const pctToPos = useCallback((pct: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    return (pct / 100) * track.clientWidth;
  }, []);

  const posToPercent = useCallback((x: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    return Math.max(0, Math.min(100, (x / track.clientWidth) * 100));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = posToPercent(x);

    const leftPos = pctToPos(value[0]);
    const rightPos = pctToPos(value[1]);
    const thumbHit = 8; // px hit zone for thumbs

    let mode: "left" | "right" | "pan";
    if (Math.abs(x - leftPos) <= thumbHit) {
      mode = "left";
    } else if (Math.abs(x - rightPos) <= thumbHit) {
      mode = "right";
    } else if (pct > value[0] && pct < value[1]) {
      mode = "pan";
    } else {
      // Click outside range — jump nearest thumb
      if (pct < value[0]) {
        onChange([Math.round(pct), value[1]]);
      } else {
        onChange([value[0], Math.round(pct)]);
      }
      return;
    }

    dragRef.current = { startX: e.clientX, startRange: [...value] as [number, number], mode };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [value, onChange, pctToPos, posToPercent]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track) return;

    const deltaPx = e.clientX - drag.startX;
    const deltaPct = (deltaPx / track.clientWidth) * 100;

    if (drag.mode === "pan") {
      const span = drag.startRange[1] - drag.startRange[0];
      let newStart = drag.startRange[0] + deltaPct;
      let newEnd = drag.startRange[1] + deltaPct;
      // Clamp to bounds
      if (newStart < 0) { newStart = 0; newEnd = span; }
      if (newEnd > 100) { newEnd = 100; newStart = 100 - span; }
      onChange([Math.round(newStart), Math.round(newEnd)]);
    } else if (drag.mode === "left") {
      const newLeft = Math.max(0, Math.min(drag.startRange[1] - 1, drag.startRange[0] + deltaPct));
      onChange([Math.round(newLeft), value[1]]);
    } else {
      const newRight = Math.max(drag.startRange[0] + 1, Math.min(100, drag.startRange[1] + deltaPct));
      onChange([value[0], Math.round(newRight)]);
    }
  }, [onChange, value]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const leftPct = value[0];
  const widthPct = value[1] - value[0];

  return (
    <div
      ref={trackRef}
      className="relative h-5 w-full cursor-pointer touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Track background */}
      <div className="absolute top-1/2 -translate-y-1/2 h-1.5 w-full rounded-full bg-muted" />
      {/* Active range */}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary cursor-grab active:cursor-grabbing"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
      {/* Left thumb */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full border border-primary bg-white shadow-sm cursor-ew-resize"
        style={{ left: `${value[0]}%` }}
      />
      {/* Right thumb */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-4 rounded-full border border-primary bg-white shadow-sm cursor-ew-resize"
        style={{ left: `${value[1]}%` }}
      />
    </div>
  );
}

// ── Timeline chart ───────────────────────────────────────────────

function TimelineTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} className="text-muted-foreground flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
          {entry.dataKey}: {entry.value.toLocaleString()}
        </p>
      ))}
    </div>
  );
}

function TimelineChart({ data, hiddenItems }: { data: TimelineData; hiddenItems: Set<string> }) {
  const [range, setRange] = useState<[number, number]>([0, 100]);
  const margin = { top: 5, right: 10, bottom: 5, left: 10 };
  const hasSeries = data.series.length > 0;

  // Flatten points into recharts format: { date, total, "4K": 10, "1080P": 20, ... }
  const allChartData = useMemo(() => data.points.map((p) => {
    const entry: Record<string, string | number> = { date: p.date, total: p.total };
    if (p.breakdown) {
      for (const [key, value] of Object.entries(p.breakdown)) {
        entry[key] = value;
      }
    }
    return entry;
  }), [data.points]);

  // Slice data to the visible range
  const chartData = useMemo(() => {
    const len = allChartData.length;
    if (len === 0) return allChartData;
    const startIdx = Math.floor((range[0] / 100) * len);
    const endIdx = Math.ceil((range[1] / 100) * len);
    return allChartData.slice(startIdx, Math.max(startIdx + 1, endIdx));
  }, [allChartData, range]);

  const visibleSeries = data.series.filter((s) => !hiddenItems.has(s));

  // Labels for the range endpoints
  const startLabel = chartData.length > 0 ? chartData[0].date : "";
  const endLabel = chartData.length > 0 ? chartData[chartData.length - 1].date : "";
  const isZoomed = range[0] > 0 || range[1] < 100;

  return (
    <div className="flex flex-col h-full">
      <div className="min-h-48 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={margin}>
            <defs>
              {hasSeries ? (
                visibleSeries.map((label, i) => {
                  const color = label === "Other" ? OTHER_HEX : AUTO_HEX[i % AUTO_HEX.length];
                  return (
                    <linearGradient key={label} id={`tl-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                  );
                })
              ) : (
                <linearGradient id="tl-grad-total" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              )}
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
            />
            <RechartsTooltip content={<TimelineTooltip />} />
            {hasSeries ? (
              visibleSeries.map((label, i) => {
                const origIdx = data.series.indexOf(label);
                const color = label === "Other" ? OTHER_HEX : AUTO_HEX[origIdx % AUTO_HEX.length];
                return (
                  <Area
                    key={label}
                    type="monotone"
                    dataKey={label}
                    stroke={color}
                    strokeWidth={1.5}
                    fill={`url(#tl-grad-${i})`}
                    fillOpacity={0.15}
                  />
                );
              })
            ) : (
              <Area
                type="monotone"
                dataKey="total"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#tl-grad-total)"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {allChartData.length > 1 && (
        <div className="mt-2 space-y-1 px-1">
          <PanSlider value={range} onChange={setRange} />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{startLabel}</span>
            {isZoomed && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setRange([0, 100])}
              >
                Reset
              </button>
            )}
            <span>{endLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chart renderer ───────────────────────────────────────────────

function renderChart(chartType: string, data: ChartDatum[]) {
  const margin = { top: 5, right: 10, bottom: 5, left: 10 };

  switch (chartType) {
    case "bar":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={margin}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <RechartsTooltip content={<CustomTooltip />} />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      );

    case "pie":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="label"
              innerRadius={40}
              outerRadius={100}
              paddingAngle={2}
              stroke="none"
            />
            <RechartsTooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      );

    case "line":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={margin}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <RechartsTooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="count"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ fill: "#3b82f6", r: 4 }}
              activeDot={{ r: 6 }}
            />
          </LineChart>
        </ResponsiveContainer>
      );

    case "area":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={margin}>
            <defs>
              <linearGradient id="customAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#b5b5b5" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <RechartsTooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="count"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#customAreaGrad)"
            />
          </AreaChart>
        </ResponsiveContainer>
      );

    case "radar":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
            <PolarGrid stroke="#333333" />
            <PolarAngleAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "#b5b5b5" }}
            />
            <RechartsTooltip content={<CustomTooltip />} />
            <Radar
              dataKey="count"
              stroke="#3b82f6"
              fill="#3b82f6"
              fillOpacity={0.2}
              strokeWidth={2}
            />
          </RadarChart>
        </ResponsiveContainer>
      );

    case "treemap": {
      const treemapData = data.map((d) => ({
        name: d.label,
        size: d.count,
        fill: d.fill,
      }));
      return (
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={treemapData}
            dataKey="size"
            aspectRatio={4 / 3}
            isAnimationActive={false}
            content={<TreemapCell />}
          >
            <RechartsTooltip content={<CustomTooltip />} />
          </Treemap>
        </ResponsiveContainer>
      );
    }

    default:
      return null;
  }
}
