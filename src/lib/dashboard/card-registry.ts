import {
  BarChart3,
  RefreshCw,
  Layers,
  MonitorPlay,
  AudioLines,
  Shield,
  Trophy,
  Sun,
  Speaker,
  Tags,
  Clock,
  LayoutDashboard,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type DashboardTab = "main" | "movies" | "series" | "music";

export type CustomChartType = "bar" | "pie" | "line" | "area" | "radar" | "treemap" | "heatmap" | "count" | "timeline";

export type TimelineBin = "day" | "week" | "month" | "quarter" | "year";

export type CustomDimension =
  | "resolution" | "videoCodec" | "audioCodec" | "contentRating"
  | "dynamicRange" | "audioChannels" | "genre"
  | "year" | "studio" | "container" | "videoProfile" | "scanType" | "aspectRatio"
  | "countries"
  | "rating" | "audienceRating" | "duration" | "fileSize" | "playCount"
  | "videoFrameRate" | "videoBitDepth" | "videoBitrate"
  | "audioProfile" | "audioSamplingRate" | "audioBitrate"
  | "audioLanguage" | "subtitleLanguage"
  | "addedAt" | "lastPlayedAt" | "originallyAvailableAt";

export interface CustomCardConfig {
  chartType: CustomChartType;
  dimension: CustomDimension;
  dimension2?: CustomDimension;
  title?: string;
  topN?: number | null;
  heatmapGradient?: string;
  countValues?: string[];
  timelineBin?: TimelineBin;
}

export const HEATMAP_GRADIENTS = [
  { id: "red-green", label: "Red \u2192 Green", low: "#ef4444", high: "#22c55e" },
  { id: "cool-warm", label: "Blue \u2192 Red", low: "#3b82f6", high: "#ef4444" },
  { id: "blue", label: "Blue", low: "#172554", high: "#3b82f6" },
  { id: "purple-orange", label: "Purple \u2192 Orange", low: "#7c3aed", high: "#f97316" },
  { id: "teal-yellow", label: "Teal \u2192 Yellow", low: "#0d9488", high: "#eab308" },
] as const;

const VALID_HEATMAP_GRADIENT_IDS = new Set<string>(HEATMAP_GRADIENTS.map((g) => g.id));

export const MIN_CARD_HEIGHT = 200;
export const MAX_CARD_HEIGHT = 800;

export interface CardEntry {
  id: string;
  size: number;
  heightPx?: number;
  config?: CustomCardConfig;
}

export type DashboardLayout = Record<DashboardTab, CardEntry[]>;

export interface DashboardCardDefinition {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  allowedTabs: DashboardTab[];
  defaultTabs: DashboardTab[];
  minSize: number;
  maxSize: number;
  defaultSize: number;
}

export const CARD_REGISTRY: DashboardCardDefinition[] = [
  {
    id: "stats",
    label: "Stats Overview",
    description: "Movie count, series count, and total storage size",
    icon: BarChart3,
    allowedTabs: ["main"],
    defaultTabs: ["main"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 12,
  },
  {
    id: "sync-status",
    label: "Sync Status",
    description: "Library sync progress and recent sync jobs",
    icon: RefreshCw,
    allowedTabs: ["main"],
    defaultTabs: [],
    minSize: 2,
    maxSize: 12,
    defaultSize: 12,
  },
  {
    id: "quality-breakdown",
    label: "Quality Breakdown",
    description: "Resolution distribution across your library",
    icon: Layers,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: ["main", "movies", "series"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 12,
  },
  {
    id: "video-codec",
    label: "Video Codec",
    description: "Video codec distribution (H.264, HEVC, etc.)",
    icon: MonitorPlay,
    allowedTabs: ["main", "movies", "series"],
    defaultTabs: ["movies", "series"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "audio-codec",
    label: "Audio Codec",
    description: "Audio codec distribution (AAC, AC3, etc.)",
    icon: AudioLines,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: ["movies", "series", "music"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "content-rating",
    label: "Content Rating",
    description: "Content rating distribution (PG, R, TV-MA, etc.)",
    icon: Shield,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: ["movies", "series"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "top-played",
    label: "Top Played",
    description: "Most played movies, series, and music",
    icon: Trophy,
    allowedTabs: ["main", "music"],
    defaultTabs: ["main"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 12,
  },
  {
    id: "dynamic-range",
    label: "Dynamic Range",
    description: "HDR format distribution (Dolby Vision, HDR10, SDR, etc.)",
    icon: Sun,
    allowedTabs: ["main", "movies", "series"],
    defaultTabs: [],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "audio-channels",
    label: "Audio Channels",
    description: "Surround sound layout distribution (Stereo, 5.1, 7.1, etc.)",
    icon: Speaker,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: [],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "genre",
    label: "Genre Breakdown",
    description: "Genre distribution across your library",
    icon: Tags,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: ["music"],
    minSize: 2,
    maxSize: 12,
    defaultSize: 6,
  },
  {
    id: "recently-added",
    label: "Recently Added",
    description: "Most recent additions to your library",
    icon: Clock,
    allowedTabs: ["main", "movies", "series", "music"],
    defaultTabs: [],
    minSize: 2,
    maxSize: 12,
    defaultSize: 12,
  },
];

const VALID_CARD_IDS = new Set(CARD_REGISTRY.map((c) => c.id));

const CARD_ALLOWED_TABS = new Map(
  CARD_REGISTRY.map((c) => [c.id, new Set(c.allowedTabs)])
);

const CARD_DEFAULTS = new Map(
  CARD_REGISTRY.map((c) => [c.id, c.defaultSize])
);

export const CUSTOM_CARD_DEFINITION: DashboardCardDefinition = {
  id: "custom",
  label: "Custom Card",
  description: "Create a chart with any dimension and chart type",
  icon: LayoutDashboard,
  allowedTabs: ["main", "movies", "series", "music"],
  defaultTabs: [],
  minSize: 2,
  maxSize: 12,
  defaultSize: 6,
};

export function isCustomCardId(id: string): boolean {
  return id.startsWith("custom-");
}

const VALID_CHART_TYPES = new Set<string>(["bar", "pie", "line", "area", "radar", "treemap", "heatmap", "count", "timeline"]);
const VALID_TIMELINE_BINS = new Set<string>(["day", "week", "month", "quarter", "year"]);
const DATE_DIMENSIONS = new Set<string>(["addedAt", "lastPlayedAt", "originallyAvailableAt"]);
const VALID_DIMENSIONS = new Set<string>([
  "resolution", "videoCodec", "audioCodec", "contentRating", "dynamicRange",
  "audioChannels", "genre", "year", "studio", "container", "videoProfile",
  "scanType", "aspectRatio", "countries", "rating", "audienceRating",
  "duration", "fileSize", "playCount",
  "videoFrameRate", "videoBitDepth", "videoBitrate",
  "audioProfile", "audioSamplingRate", "audioBitrate",
  "audioLanguage", "subtitleLanguage",
  "addedAt", "lastPlayedAt", "originallyAvailableAt",
]);

function isValidCustomConfig(config: unknown): config is CustomCardConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  if (!VALID_CHART_TYPES.has(c.chartType as string)) return false;
  if (!VALID_DIMENSIONS.has(c.dimension as string)) return false;
  if (c.title !== undefined && typeof c.title !== "string") return false;
  if (c.topN !== undefined && c.topN !== null && (typeof c.topN !== "number" || c.topN < 1)) return false;
  if (c.heatmapGradient !== undefined && !VALID_HEATMAP_GRADIENT_IDS.has(c.heatmapGradient as string)) return false;
  if (c.countValues !== undefined && (!Array.isArray(c.countValues) || !c.countValues.every((v: unknown) => typeof v === "string"))) return false;
  if (c.chartType === "heatmap") {
    if (!VALID_DIMENSIONS.has(c.dimension2 as string)) return false;
    if (c.dimension === c.dimension2) return false;
  }
  if (c.chartType === "timeline") {
    if (!DATE_DIMENSIONS.has(c.dimension as string)) return false;
    if (!c.timelineBin || !VALID_TIMELINE_BINS.has(c.timelineBin as string)) return false;
    if (c.dimension2 !== undefined && !VALID_DIMENSIONS.has(c.dimension2 as string)) return false;
  }
  return true;
}

export function getCardDefinition(id: string): DashboardCardDefinition | undefined {
  return CARD_REGISTRY.find((c) => c.id === id);
}

export function getDefaultLayout(): DashboardLayout {
  return {
    main: CARD_REGISTRY.filter((c) => c.defaultTabs.includes("main")).map(
      (c) => ({ id: c.id, size: c.defaultSize })
    ),
    movies: CARD_REGISTRY.filter((c) => c.defaultTabs.includes("movies")).map(
      (c) => ({ id: c.id, size: c.defaultSize })
    ),
    series: CARD_REGISTRY.filter((c) => c.defaultTabs.includes("series")).map(
      (c) => ({ id: c.id, size: c.defaultSize })
    ),
    music: CARD_REGISTRY.filter((c) => c.defaultTabs.includes("music")).map(
      (c) => ({ id: c.id, size: c.defaultSize })
    ),
  };
}

function clampHeight(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, Math.round(raw)));
}

/** Normalize a raw tab array (may be old string[] or new CardEntry[]) into CardEntry[] */
function normalizeTab(
  raw: unknown[],
  tab: DashboardTab,
  defaults: CardEntry[]
): CardEntry[] {
  if (raw.length === 0) return defaults;

  // Old format: string[]
  if (typeof raw[0] === "string") {
    const seen = new Set<string>();
    const result: CardEntry[] = [];
    for (const item of raw) {
      const id = item as string;
      if (!VALID_CARD_IDS.has(id)) continue;
      if (!CARD_ALLOWED_TABS.get(id)?.has(tab)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ id, size: CARD_DEFAULTS.get(id) ?? 12 });
    }
    return result;
  }

  // New format: CardEntry[]
  const seen = new Set<string>();
  const result: CardEntry[] = [];
  for (const item of raw) {
    const entry = item as CardEntry & { config?: unknown };
    if (!entry.id || typeof entry.id !== "string") continue;

    if (isCustomCardId(entry.id)) {
      if (!isValidCustomConfig(entry.config)) continue;
      const size =
        typeof entry.size === "number"
          ? Math.max(CUSTOM_CARD_DEFINITION.minSize, Math.min(CUSTOM_CARD_DEFINITION.maxSize, entry.size))
          : CUSTOM_CARD_DEFINITION.defaultSize;
      const heightPx = clampHeight(entry.heightPx);
      result.push({ id: entry.id, size, ...(heightPx != null && { heightPx }), config: entry.config });
      continue;
    }

    if (!VALID_CARD_IDS.has(entry.id)) continue;
    if (!CARD_ALLOWED_TABS.get(entry.id)?.has(tab)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const def = getCardDefinition(entry.id);
    const size =
      typeof entry.size === "number" && def
        ? Math.max(def.minSize, Math.min(def.maxSize, entry.size))
        : CARD_DEFAULTS.get(entry.id) ?? 12;
    const heightPx = clampHeight(entry.heightPx);
    result.push({ id: entry.id, size, ...(heightPx != null && { heightPx }) });
  }
  return result;
}

export function resolveLayout(saved: DashboardLayout | null): DashboardLayout {
  const defaults = getDefaultLayout();
  if (!saved) return defaults;

  return {
    main: Array.isArray(saved.main)
      ? normalizeTab(saved.main, "main", defaults.main)
      : defaults.main,
    movies: Array.isArray(saved.movies)
      ? normalizeTab(saved.movies, "movies", defaults.movies)
      : defaults.movies,
    series: Array.isArray(saved.series)
      ? normalizeTab(saved.series, "series", defaults.series)
      : defaults.series,
    music: Array.isArray(saved.music)
      ? normalizeTab(saved.music, "music", defaults.music)
      : defaults.music,
  };
}

export function isValidLayout(layout: unknown): layout is DashboardLayout {
  if (!layout || typeof layout !== "object") return false;
  const obj = layout as Record<string, unknown>;

  for (const tab of ["main", "movies", "series", "music"] as const) {
    if (!Array.isArray(obj[tab])) return false;
    const entries = obj[tab] as unknown[];
    const seenStatic = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.size !== "number") return false;
      if (e.heightPx !== undefined && (typeof e.heightPx !== "number" || e.heightPx < MIN_CARD_HEIGHT || e.heightPx > MAX_CARD_HEIGHT)) return false;

      if (isCustomCardId(e.id)) {
        if (!isValidCustomConfig(e.config)) return false;
        continue;
      }

      if (!VALID_CARD_IDS.has(e.id)) return false;
      if (!CARD_ALLOWED_TABS.get(e.id)?.has(tab)) return false;
      if (seenStatic.has(e.id)) return false;
      seenStatic.add(e.id);
    }
  }

  return true;
}
