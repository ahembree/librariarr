import { normalizeResolutionLabel, QUALITY_ORDER } from "@/lib/resolution";
import { AUDIO_CODEC_ORDER, type ChipColorCategory } from "@/lib/theme/chip-colors";

/**
 * The one set of rules for the coloured quality chips — and the quality-bar
 * segments cards draw from the same values — so a value reads the same on a
 * card, in a table, in a hover card, on a detail page and in the side panel:
 *
 * - a missing value shows no chip (a table cell shows "-" in its place);
 *   it is never read as "SDR", "Unknown" or "Other";
 * - a resolution shows its standard label ("4K", "1080P"), and a value that
 *   maps to none of them its own spelling;
 * - SDR is a dynamic range like any other and is shown;
 * - an audio codec is upper-cased ("AAC"), as the counts are;
 * - counts are listed in the canonical order (`QUALITY_ORDER`,
 *   `AUDIO_CODEC_ORDER`, then the rest by name) and empty buckets dropped.
 *
 * Kept free of React so the rules are unit-tested; `QualityChip` in
 * `src/components/quality-chips.tsx` draws them.
 */

/** Card-display toggle (`useCardDisplay`'s badge keys) a chip answers to. */
export type QualityChipToggle =
  | "resolution"
  | "dynamicRange"
  | "audioProfile"
  | "audioCodec"
  | "qualityCounts"
  | "audioCodecs";

export interface QualityChipSpec {
  category: ChipColorCategory;
  /** The value as shown, which is also what the colour is looked up by. */
  label: string;
  /** How many items carry it, on a chip that stands for a group. */
  count?: number;
  /** Text after the label inside the chip (a codec's channel count). */
  detail?: string;
  /** The card-display toggle that hides it on a card; absent, always shown. */
  toggle?: QualityChipToggle;
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolutionChipLabel(resolution: string | null | undefined): string | null {
  const raw = present(resolution);
  if (!raw) return null;
  const label = normalizeResolutionLabel(raw);
  return label === "Other" ? raw : label;
}

export function dynamicRangeChipLabel(dynamicRange: string | null | undefined): string | null {
  return present(dynamicRange);
}

export function audioProfileChipLabel(audioProfile: string | null | undefined): string | null {
  return present(audioProfile);
}

export function audioCodecChipLabel(audioCodec: string | null | undefined): string | null {
  return present(audioCodec)?.toUpperCase() ?? null;
}

/** Non-empty buckets in `order`, then any others by name. */
function orderCounts(
  counts: Record<string, number> | null | undefined,
  order: readonly string[],
  last: readonly string[] = [],
): [string, number][] {
  if (!counts) return [];
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  const rank = (key: string) => {
    const i = order.indexOf(key);
    if (i >= 0) return i;
    return last.includes(key) ? order.length + 1 : order.length;
  };
  return entries.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export function orderedQualityCounts(counts: Record<string, number> | null | undefined): [string, number][] {
  return orderCounts(counts, QUALITY_ORDER);
}

export function orderedAudioCodecCounts(counts: Record<string, number> | null | undefined): [string, number][] {
  // Counts keyed by a codec spelled in another case still land in order.
  const upper: Record<string, number> = {};
  for (const [codec, n] of Object.entries(counts ?? {})) {
    const key = codec.toUpperCase() === "UNKNOWN" ? "Unknown" : codec.toUpperCase();
    upper[key] = (upper[key] ?? 0) + n;
  }
  return orderCounts(upper, AUDIO_CODEC_ORDER, ["Unknown"]);
}

export interface QualityChipSource {
  resolution?: string | null;
  dynamicRange?: string | null;
  audioProfile?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  qualityCounts?: Record<string, number> | null;
  audioCodecCounts?: Record<string, number> | null;
}

/**
 * The chips one item — or one group — shows. A video item shows resolution,
 * dynamic range and audio profile; a track its audio codec; a show or season
 * its resolution counts; an artist or album its codec counts.
 */
export function qualityChips(
  source: QualityChipSource,
  kind: "video" | "music",
  options: { channels?: boolean } = {},
): QualityChipSpec[] {
  if (source.qualityCounts) {
    return orderedQualityCounts(source.qualityCounts).map(([label, count]) => ({
      category: "resolution", label, count, toggle: "qualityCounts",
    }));
  }
  if (source.audioCodecCounts) {
    return orderedAudioCodecCounts(source.audioCodecCounts).map(([label, count]) => ({
      category: "audioCodec", label, count, toggle: "audioCodecs",
    }));
  }
  const chips: QualityChipSpec[] = [];
  if (kind === "music") {
    const codec = audioCodecChipLabel(source.audioCodec);
    if (codec) {
      chips.push({
        category: "audioCodec",
        label: codec,
        toggle: "audioCodec",
        ...(options.channels && source.audioChannels ? { detail: `${source.audioChannels}ch` } : {}),
      });
    }
    return chips;
  }
  const resolution = resolutionChipLabel(source.resolution);
  if (resolution) chips.push({ category: "resolution", label: resolution, toggle: "resolution" });
  const dynamicRange = dynamicRangeChipLabel(source.dynamicRange);
  if (dynamicRange) chips.push({ category: "dynamicRange", label: dynamicRange, toggle: "dynamicRange" });
  const audioProfile = audioProfileChipLabel(source.audioProfile);
  if (audioProfile) chips.push({ category: "audioProfile", label: audioProfile, toggle: "audioProfile" });
  return chips;
}

/** What a chip reads, count included. */
export function qualityChipText(chip: QualityChipSpec): string {
  const base = chip.detail ? `${chip.label} ${chip.detail}` : chip.label;
  return chip.count != null ? `${base}: ${chip.count}` : base;
}

export interface QualitySegment {
  color: string;
  weight: number;
  label?: string;
}

/** A card's quality bar: one segment per chip, sized by its count. */
export function qualitySegments(
  chips: QualityChipSpec[],
  getHex: (category: ChipColorCategory, value: string) => string,
  show: (toggle: QualityChipToggle) => boolean = () => true,
): QualitySegment[] {
  return chips
    .filter((chip) => !chip.toggle || show(chip.toggle))
    .map((chip) => ({
      color: getHex(chip.category, chip.label),
      weight: chip.count ?? 1,
      label: qualityChipText(chip),
    }));
}
