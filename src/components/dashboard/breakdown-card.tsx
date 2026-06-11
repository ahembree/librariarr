"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { BarChart3, PieChart as PieChartIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { OTHER_HEX } from "@/components/dashboard/chart-palette";
import {
  InsightCard,
  InsightEmpty,
  SegmentedToggle,
} from "@/components/dashboard/insight-card";

export interface BreakdownEntry {
  label: string;
  movies: number;
  series: number;
  music: number;
}

type MediaType = "MOVIE" | "SERIES" | "MUSIC";
type CountKey = "movies" | "series" | "music";

const TYPE_KEY: Record<MediaType, CountKey> = {
  MOVIE: "movies",
  SERIES: "series",
  MUSIC: "music",
};

interface BreakdownCardProps {
  title: string;
  icon: LucideIcon;
  /** Aggregated per-label counts in the caller's preferred display order. */
  entries: BreakdownEntry[];
  colorFor: (label: string) => string;
  /** "preserve" keeps the caller's order (quality ladder); "byValue" ranks
   *  by the currently selected type's count. */
  sortMode?: "preserve" | "byValue";
  onLabelClick?: (label: string) => void;
  filterType?: MediaType;
  lockedFilterType?: boolean;
  availableTypes?: string[];
  emptyMessage?: string;
}

function valueOf(entry: BreakdownEntry, type: MediaType | undefined): number {
  if (!type) return entry.movies + entry.series + entry.music;
  return entry[TYPE_KEY[type]];
}

/** Donut with the total (or hovered segment) in the center. Pure SVG via
 *  stroke-dasharray rings — no chart library needed for a single series. */
function Donut({
  segments,
  total,
  unit,
}: {
  segments: { label: string; value: number; color: string }[];
  total: number;
  unit: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const R = 42;
  const C = 2 * Math.PI * R;

  // Precompute each segment's arc length and cumulative start offset.
  const arcs: { len: number; start: number }[] = [];
  for (const seg of segments) {
    const len = total > 0 ? (seg.value / total) * C : 0;
    const prev = arcs[arcs.length - 1];
    arcs.push({ len, start: prev ? prev.start + prev.len : 0 });
  }

  const active = hovered !== null ? segments[hovered] : null;

  return (
    <div className="relative mx-auto h-44 w-44">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        {segments.map((seg, i) => {
          const { len, start } = arcs[i];
          const dashOffset = -start;
          return (
            <circle
              key={seg.label}
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke={seg.color}
              strokeWidth={hovered === i ? 13 : 11}
              strokeDasharray={`${Math.max(len - 0.8, 0.1)} ${C - Math.max(len - 0.8, 0.1)}`}
              strokeDashoffset={dashOffset}
              className="cursor-pointer transition-[stroke-width,opacity]"
              opacity={hovered === null || hovered === i ? 1 : 0.35}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        {active ? (
          <>
            <span className="max-w-28 truncate text-sm font-semibold">{active.label}</span>
            <span className="font-mono text-xs tabular-nums">{active.value.toLocaleString()}</span>
            <span className="font-mono text-[10.5px] text-faint">
              {total > 0 ? ((active.value / total) * 100).toFixed(1) : 0}%
            </span>
          </>
        ) : (
          <>
            <span className="font-display text-2xl font-semibold tabular-nums tracking-tight">
              {total.toLocaleString()}
            </span>
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-faint uppercase">
              {unit}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Unified distribution card: per-type proportion strips (or a donut) above
 * ranked label rows whose background fill encodes share-of-max. Rows are
 * the legend AND the table — click one to hide it from the totals; the
 * old paginated table is gone.
 */
export function BreakdownCard({
  title,
  icon,
  entries,
  colorFor,
  sortMode = "byValue",
  onLabelClick,
  filterType,
  lockedFilterType,
  availableTypes,
  emptyMessage = "No data available.",
}: BreakdownCardProps) {
  const [view, setView] = useState<"bars" | "donut">("bars");
  const [topN, setTopN] = useState<number | null>(5);
  const [localType, setLocalType] = useState<MediaType | undefined>(filterType);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Sync local override when the page-level filter changes (React 19 idiom).
  const [prevFilterType, setPrevFilterType] = useState(filterType);
  if (prevFilterType !== filterType) {
    setPrevFilterType(filterType);
    setLocalType(filterType);
  }
  const effectiveType = lockedFilterType ? filterType : localType;

  const showType = (t: MediaType) =>
    !availableTypes || availableTypes.length === 0 || availableTypes.includes(t);

  // Rank by the selected scope, drop empty labels, fold the tail into "Other".
  const withValues = entries
    .map((e) => ({ ...e, value: valueOf(e, effectiveType) }))
    .filter((e) => e.value > 0);
  const ranked =
    sortMode === "byValue" ? [...withValues].sort((a, b) => b.value - a.value) : withValues;

  let display = ranked;
  if (topN !== null && ranked.length > topN) {
    const tail = ranked.slice(topN);
    const other = tail.reduce(
      (acc, e) => ({
        label: "Other",
        movies: acc.movies + e.movies,
        series: acc.series + e.series,
        music: acc.music + e.music,
        value: acc.value + e.value,
      }),
      { label: "Other", movies: 0, series: 0, music: 0, value: 0 },
    );
    display = [...ranked.slice(0, topN), other];
  }

  const visible = display.filter((e) => !hidden.has(e.label));
  const total = visible.reduce((sum, e) => sum + e.value, 0);
  const maxValue = Math.max(...visible.map((e) => e.value), 1);

  const toggleHidden = (label: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const colorOf = (label: string) =>
    label === "Other" ? OTHER_HEX : colorFor(label);

  const typeSelect = !lockedFilterType && (
    <Select
      value={localType ?? "all"}
      onValueChange={(v) => setLocalType(v === "all" ? undefined : (v as MediaType))}
    >
      <SelectTrigger size="sm" className="w-24 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Types</SelectItem>
        {showType("MOVIE") && <SelectItem value="MOVIE">Movies</SelectItem>}
        {showType("SERIES") && <SelectItem value="SERIES">Series</SelectItem>}
        {showType("MUSIC") && <SelectItem value="MUSIC">Music</SelectItem>}
      </SelectContent>
    </Select>
  );

  if (withValues.length === 0) {
    return (
      <InsightCard icon={icon} title={title} controls={typeSelect || undefined}>
        <InsightEmpty icon={icon} message={emptyMessage} />
      </InsightCard>
    );
  }

  // Per-type proportion strips (the at-a-glance distribution view).
  const strips: { label: string; key: CountKey }[] = effectiveType
    ? [{ label: "", key: TYPE_KEY[effectiveType] }]
    : [
        { label: "Movies", key: "movies" as const },
        { label: "Series", key: "series" as const },
        ...(showType("MUSIC") ? [{ label: "Music", key: "music" as const }] : []),
      ];

  return (
    <InsightCard
      icon={icon}
      title={title}
      sub={`${total.toLocaleString()} items · ${withValues.length.toLocaleString()} values`}
      controls={
        <>
          {typeSelect}
          <Select
            value={topN === null ? "all" : String(topN)}
            onValueChange={(v) => setTopN(v === "all" ? null : Number(v))}
          >
            <SelectTrigger size="sm" className="w-22 text-xs">
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
          <SegmentedToggle
            value={view}
            onChange={setView}
            options={[
              { value: "bars", icon: BarChart3, label: "Bars view" },
              { value: "donut", icon: PieChartIcon, label: "Donut view" },
            ]}
          />
        </>
      }
    >
      {view === "bars" ? (
        <TooltipProvider delayDuration={150}>
          <div className="mb-4 space-y-2.5">
            {strips.map(({ label: stripLabel, key }) => {
              const stripTotal = visible.reduce((sum, e) => sum + e[key], 0);
              return (
                <div key={key || "single"}>
                  {stripLabel && (
                    <p className="mb-1 font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
                      {stripLabel}
                    </p>
                  )}
                  <div className="flex h-2.5 gap-px overflow-hidden rounded-full">
                    {stripTotal === 0 ? (
                      <div className="h-full w-full bg-muted" />
                    ) : (
                      visible.map((e) => {
                        const pct = (e[key] / stripTotal) * 100;
                        if (pct === 0) return null;
                        return (
                          <Tooltip key={e.label}>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  "h-full transition-opacity",
                                  onLabelClick && "cursor-pointer hover:opacity-75",
                                )}
                                style={{ width: `${pct}%`, backgroundColor: colorOf(e.label) }}
                                onClick={
                                  onLabelClick ? () => onLabelClick(e.label) : undefined
                                }
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p className="font-medium">{e.label}</p>
                              <p>
                                {e[key].toLocaleString()} ({pct.toFixed(1)}%)
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </TooltipProvider>
      ) : (
        <div className="mb-4">
          <Donut
            segments={visible.map((e) => ({
              label: e.label,
              value: e.value,
              color: colorOf(e.label),
            }))}
            total={total}
            unit="items"
          />
        </div>
      )}

      {/* Ranked rows: legend + table in one. Click to hide/show a value. */}
      <div className="space-y-0.5">
        {display.map((e) => {
          const isHidden = hidden.has(e.label);
          const pct = total > 0 && !isHidden ? (e.value / total) * 100 : 0;
          const fillPct = isHidden ? 0 : (e.value / maxValue) * 100;
          const color = colorOf(e.label);
          const typeSplit = !effectiveType
            ? `Movies ${e.movies.toLocaleString()} · Series ${e.series.toLocaleString()}${e.music > 0 ? ` · Music ${e.music.toLocaleString()}` : ""}`
            : undefined;
          return (
            <button
              key={e.label}
              type="button"
              onClick={() => toggleHidden(e.label)}
              aria-pressed={isHidden}
              title={typeSplit ? `${e.label} — ${typeSplit}` : `${e.label} — click to toggle`}
              className={cn(
                "relative flex w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40",
                isHidden && "opacity-40",
              )}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-md transition-[width] duration-300"
                style={{ width: `${fillPct}%`, backgroundColor: `${color}1f` }}
              />
              <span
                className="relative h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: isHidden ? OTHER_HEX : color }}
              />
              <span
                className={cn(
                  "relative flex-1 truncate text-[13px] font-medium",
                  isHidden && "line-through",
                )}
              >
                {e.label}
              </span>
              <span className="relative font-mono text-xs tabular-nums">
                {e.value.toLocaleString()}
              </span>
              <span className="relative w-12 text-right font-mono text-[10.5px] tabular-nums text-faint">
                {isHidden ? "—" : `${pct.toFixed(1)}%`}
              </span>
            </button>
          );
        })}
      </div>
    </InsightCard>
  );
}
