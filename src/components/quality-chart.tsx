"use client";

import { Layers } from "lucide-react";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import {
  BreakdownCard,
  type BreakdownEntry,
} from "@/components/dashboard/breakdown-card";

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

/** Display order: quality ladder, not count. */
const LABEL_ORDER = ["4K", "1080P", "720P", "480P", "SD", "Other"];

/** Resolution distribution card — aggregates raw per-type rows into the
 *  unified BreakdownCard, ordered by the quality ladder and colored from
 *  the user's resolution chip colors. */
export function QualityChart({
  breakdown,
  onQualityClick,
  filterType,
  lockedFilterType,
  availableTypes,
}: QualityChartProps) {
  const { getHex } = useChipColors();

  const aggregated = new Map<string, BreakdownEntry>();
  for (const item of breakdown) {
    const label = normalizeResolutionLabel(item.resolution);
    const entry =
      aggregated.get(label) ?? { label, movies: 0, series: 0, music: 0 };
    if (item.type === "MOVIE") entry.movies += item._count;
    else if (item.type === "MUSIC") entry.music += item._count;
    else entry.series += item._count;
    aggregated.set(label, entry);
  }

  const entries = Array.from(aggregated.values()).sort((a, b) => {
    const ai = LABEL_ORDER.indexOf(a.label);
    const bi = LABEL_ORDER.indexOf(b.label);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <BreakdownCard
      title="Quality Breakdown"
      icon={Layers}
      entries={entries}
      colorFor={(label) => getHex("resolution", label)}
      sortMode="preserve"
      onLabelClick={onQualityClick}
      filterType={filterType}
      lockedFilterType={lockedFilterType}
      availableTypes={availableTypes}
      emptyMessage="No media data yet. Sync a server to see quality breakdown."
    />
  );
}
