"use client";

import { BarChart3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AUTO_HEX, OTHER_HEX } from "@/components/dashboard/chart-palette";
import {
  BreakdownCard,
  type BreakdownEntry,
} from "@/components/dashboard/breakdown-card";

interface BreakdownChartProps {
  title: string;
  icon?: LucideIcon;
  breakdown: {
    value: string | null;
    type: string;
    _count: number;
  }[];
  hexColors?: Record<string, string>;
  nullLabel?: string;
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  availableTypes?: string[];
  /** Transform labels for display. Defaults to toUpperCase. */
  labelTransform?: (value: string) => string;
}

/** Generic categorical distribution card (codecs, ratings, genres, …) —
 *  aggregates raw per-type rows into the unified BreakdownCard. Colors
 *  come from the chip-color map when provided, else the shared palette
 *  assigned by rank. */
export function BreakdownChart({
  title,
  icon = BarChart3,
  breakdown,
  hexColors,
  nullLabel = "Unknown",
  filterType,
  lockedFilterType,
  availableTypes,
  labelTransform = (v) => v.toUpperCase(),
}: BreakdownChartProps) {
  const aggregated = new Map<string, BreakdownEntry>();
  for (const item of breakdown) {
    const label =
      item.value && item.value.trim() !== "" ? labelTransform(item.value) : nullLabel;
    const entry =
      aggregated.get(label) ?? { label, movies: 0, series: 0, music: 0 };
    if (item.type === "MOVIE") entry.movies += item._count;
    else if (item.type === "MUSIC") entry.music += item._count;
    else entry.series += item._count;
    aggregated.set(label, entry);
  }

  // Rank by overall total to assign stable palette colors by prominence.
  const entries = Array.from(aggregated.values()).sort(
    (a, b) =>
      b.movies + b.series + b.music - (a.movies + a.series + a.music),
  );
  const hexMap: Record<string, string> = {};
  entries.forEach((e, i) => {
    hexMap[e.label] =
      e.label === "Other" && !hexColors?.[e.label]
        ? OTHER_HEX
        : (hexColors?.[e.label] ?? AUTO_HEX[i % AUTO_HEX.length]);
  });

  return (
    <BreakdownCard
      title={title}
      icon={icon}
      entries={entries}
      colorFor={(label) => hexMap[label] ?? OTHER_HEX}
      filterType={filterType}
      lockedFilterType={lockedFilterType}
      availableTypes={availableTypes}
    />
  );
}
