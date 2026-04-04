"use client";

import { cn } from "@/lib/utils";

interface RatingChipProps {
  label: string;
  value: number;
  /** Min rating value — anything at or below is fully red (default 3) */
  min?: number;
  /** Max rating value — anything at or above is fully green (default 8) */
  max?: number;
  className?: string;
}

/**
 * Displays a rating value inside a colored chip.
 * Color interpolates from red (low) through amber (mid) to green (high).
 */
export function RatingChip({ label, value, min = 3, max = 8, className }: RatingChipProps) {
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));

  // Interpolate hue: 0 (red) → 85 (green) in OKLCH
  // Red: oklch(0.65 0.22 25), Amber: oklch(0.78 0.16 75), Green: oklch(0.72 0.19 145)
  const hue = 25 + ratio * 120; // 25 (red) → 145 (green)
  const chroma = ratio < 0.5
    ? 0.22 - (ratio * 2) * 0.06  // 0.22 → 0.16
    : 0.16 + ((ratio - 0.5) * 2) * 0.03; // 0.16 → 0.19
  const lightness = ratio < 0.5
    ? 0.65 + (ratio * 2) * 0.13 // 0.65 → 0.78
    : 0.78 - ((ratio - 0.5) * 2) * 0.06; // 0.78 → 0.72

  const bgColor = `oklch(${lightness} ${chroma} ${hue} / 0.15)`;
  const textColor = `oklch(${lightness} ${chroma} ${hue})`;
  const borderColor = `oklch(${lightness} ${chroma} ${hue} / 0.3)`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium leading-none border",
        className,
      )}
      style={{
        backgroundColor: bgColor,
        color: textColor,
        borderColor: borderColor,
      }}
    >
      <span className="text-white/60">{label}</span>
      <span className="font-semibold">{value.toFixed(1)}</span>
    </span>
  );
}
