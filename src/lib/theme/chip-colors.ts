/**
 * Centralized chip/badge color system.
 *
 * Defines default hex colors for resolution, dynamic range, and audio profile
 * chips/badges used across the app (library tables, detail panels, charts, etc.).
 *
 * Users can override these defaults via Settings > Appearance.
 * The overrides are stored in AppSettings.chipColors as JSON.
 */

// ── Color categories ──────────────────────────────────────────────

export type ChipColorCategory = "resolution" | "dynamicRange" | "audioProfile" | "audioCodec";

export interface ChipColorMap {
  resolution: Record<string, string>;
  dynamicRange: Record<string, string>;
  audioProfile: Record<string, string>;
  audioCodec: Record<string, string>;
}

// ── Default colors (hex) ──────────────────────────────────────────

export const DEFAULT_CHIP_COLORS: ChipColorMap = {
  resolution: {
    "4K": "#a855f7",
    "1080P": "#3b82f6",
    "720P": "#22c55e",
    "480P": "#eab308",
    SD: "#ef4444",
    Other: "#6b7280",
  },
  dynamicRange: {
    "Dolby Vision": "#a855f7",
    "HDR10+": "#f59e0b",
    HDR10: "#3b82f6",
    HLG: "#22c55e",
    SDR: "#71717a",
  },
  audioProfile: {
    "Dolby Atmos": "#a855f7",
    "Dolby TrueHD": "#3b82f6",
    "DTS-HD MA": "#22c55e",
    "DTS:X": "#14b8a6",
  },
  audioCodec: {
    FLAC: "#a855f7",
    ALAC: "#8b5cf6",
    WAV: "#6366f1",
    OPUS: "#3b82f6",
    VORBIS: "#0ea5e9",
    AAC: "#22c55e",
    MP3: "#eab308",
    AC3: "#f97316",
    EAC3: "#f59e0b",
    DTS: "#14b8a6",
    PCM: "#06b6d4",
    WMA: "#ef4444",
  },
};

// Fallback color for values not in the map
export const FALLBACK_HEX = "#6b7280";

/** Canonical display order for audio codecs (lossless → lossy → compressed). */
export const AUDIO_CODEC_ORDER = [
  "FLAC", "ALAC", "WAV", "PCM", "DTS", "OPUS", "VORBIS", "AAC",
  "EAC3", "AC3", "MP3", "WMA",
] as const;

// ── Palette of selectable colors ──────────────────────────────────

export interface ColorPreset {
  name: string;
  hex: string;
}

export const COLOR_PALETTE: ColorPreset[] = [
  { name: "Purple", hex: "#a855f7" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Sky", hex: "#0ea5e9" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Green", hex: "#22c55e" },
  { name: "Lime", hex: "#84cc16" },
  { name: "Yellow", hex: "#eab308" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Orange", hex: "#f97316" },
  { name: "Red", hex: "#ef4444" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Fuchsia", hex: "#d946ef" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Zinc", hex: "#71717a" },
  { name: "Gray", hex: "#6b7280" },
];

// ── Helpers: derive badge/chart styles from hex ───────────────────

/** Convert hex (#rgb or #rrggbb) to rgba string. Falls back to the neutral color on malformed input. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = FALLBACK_HEX.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Get inline styles for a semi-transparent badge (tables, detail panels) */
export function getChipBadgeStyle(hex: string): React.CSSProperties {
  return {
    backgroundColor: hexToRgba(hex, 0.2),
    color: hex,
    borderColor: hexToRgba(hex, 0.3),
  };
}

/** Get inline styles for a solid badge (series cards, quality chart bars) */
export function getChipSolidStyle(hex: string): React.CSSProperties {
  return {
    backgroundColor: hex,
    color: "#fff",
  };
}

/** Merge user overrides with defaults. Only overrides present keys. */
export function mergeChipColors(overrides?: Partial<ChipColorMap> | null): ChipColorMap {
  if (!overrides) return { ...DEFAULT_CHIP_COLORS };
  return {
    resolution: { ...DEFAULT_CHIP_COLORS.resolution, ...overrides.resolution },
    dynamicRange: { ...DEFAULT_CHIP_COLORS.dynamicRange, ...overrides.dynamicRange },
    audioProfile: { ...DEFAULT_CHIP_COLORS.audioProfile, ...overrides.audioProfile },
    audioCodec: { ...DEFAULT_CHIP_COLORS.audioCodec, ...overrides.audioCodec },
  };
}

// ── Category display metadata ─────────────────────────────────────

export const CHIP_CATEGORY_LABELS: Record<ChipColorCategory, string> = {
  resolution: "Resolution",
  dynamicRange: "Dynamic Range",
  audioProfile: "Audio Profile",
  audioCodec: "Audio Codec",
};

export const CHIP_CATEGORY_ORDER: ChipColorCategory[] = [
  "resolution",
  "dynamicRange",
  "audioProfile",
  "audioCodec",
];
