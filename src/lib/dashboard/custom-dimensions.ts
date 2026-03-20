import type { CustomDimension } from "./card-registry";

export type DimensionCategory =
  | "direct"
  | "value_map"
  | "json_unnest"
  | "numeric_bucket"
  | "stream_group"
  | "date_bucket";

export interface DimensionMeta {
  id: CustomDimension;
  label: string;
  group: string;
  dbField: string;
  category: DimensionCategory;
  nullLabel: string;
  excludeTypes?: string[];
  bucketConfig?: { ranges: [number | null, number | null, string][] };
  /** For value_map: maps raw DB values to display labels (post-aggregation) */
  valueMapFn?: (raw: string | null) => string;
  /** For stream_group: the stream type filter (1=video, 2=audio, 3=subtitle) */
  streamType?: number;
  /** For stream_group: the stream column to group by */
  streamField?: string;
  /** For date_bucket: the granularity */
  dateBucketGranularity?: "month" | "year";
}

export const DIMENSION_REGISTRY: DimensionMeta[] = [
  // Video
  {
    id: "resolution", label: "Resolution", group: "Video", dbField: "resolution", category: "value_map", nullLabel: "Unknown", excludeTypes: ["MUSIC"],
    valueMapFn: normalizeResolutionBin,
  },
  { id: "videoCodec", label: "Video Codec", group: "Video", dbField: "videoCodec", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "dynamicRange", label: "Dynamic Range", group: "Video", dbField: "dynamicRange", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "videoProfile", label: "Video Profile", group: "Video", dbField: "videoProfile", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "videoFrameRate", label: "Frame Rate", group: "Video", dbField: "videoFrameRate", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "videoBitDepth", label: "Bit Depth", group: "Video", dbField: "videoBitDepth", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "scanType", label: "Scan Type", group: "Video", dbField: "scanType", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  { id: "aspectRatio", label: "Aspect Ratio", group: "Video", dbField: "aspectRatio", category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"] },
  {
    id: "videoBitrate", label: "Video Bitrate", group: "Video", dbField: "videoBitrate", category: "numeric_bucket", nullLabel: "Unknown", excludeTypes: ["MUSIC"],
    bucketConfig: {
      ranges: [
        [null, 2_000, "< 2 Mbps"],
        [2_000, 5_000, "2–5 Mbps"],
        [5_000, 10_000, "5–10 Mbps"],
        [10_000, 20_000, "10–20 Mbps"],
        [20_000, 40_000, "20–40 Mbps"],
        [40_000, null, "40+ Mbps"],
      ],
    },
  },
  // Audio
  { id: "audioCodec", label: "Audio Codec", group: "Audio", dbField: "audioCodec", category: "direct", nullLabel: "Unknown" },
  { id: "audioChannels", label: "Audio Channels", group: "Audio", dbField: "audioChannels", category: "direct", nullLabel: "Unknown" },
  { id: "audioProfile", label: "Audio Profile", group: "Audio", dbField: "audioProfile", category: "direct", nullLabel: "Unknown" },
  { id: "audioSamplingRate", label: "Sampling Rate", group: "Audio", dbField: "audioSamplingRate", category: "direct", nullLabel: "Unknown" },
  {
    id: "audioBitrate", label: "Audio Bitrate", group: "Audio", dbField: "audioBitrate", category: "numeric_bucket", nullLabel: "Unknown",
    bucketConfig: {
      ranges: [
        [null, 128, "< 128 kbps"],
        [128, 256, "128–256 kbps"],
        [256, 512, "256–512 kbps"],
        [512, 1_000, "512–1000 kbps"],
        [1_000, null, "1000+ kbps"],
      ],
    },
  },
  // Streams
  {
    id: "audioLanguage", label: "Audio Language", group: "Streams", dbField: "language", category: "stream_group", nullLabel: "Unknown",
    streamType: 2, streamField: "language",
  },
  {
    id: "subtitleLanguage", label: "Subtitle Language", group: "Streams", dbField: "language", category: "stream_group", nullLabel: "Unknown",
    streamType: 3, streamField: "language",
  },
  // Content
  { id: "contentRating", label: "Content Rating", group: "Content", dbField: "contentRating", category: "direct", nullLabel: "Not Rated" },
  { id: "genre", label: "Genre", group: "Content", dbField: "genres", category: "json_unnest", nullLabel: "Unknown" },
  { id: "year", label: "Year", group: "Content", dbField: "year", category: "direct", nullLabel: "Unknown" },
  { id: "studio", label: "Studio", group: "Content", dbField: "studio", category: "direct", nullLabel: "Unknown" },
  { id: "countries", label: "Countries", group: "Content", dbField: "countries", category: "json_unnest", nullLabel: "Unknown" },
  // File
  { id: "container", label: "Container", group: "File", dbField: "container", category: "direct", nullLabel: "Unknown" },
  {
    id: "fileSize", label: "File Size", group: "File", dbField: "fileSize", category: "numeric_bucket", nullLabel: "Unknown",
    bucketConfig: {
      ranges: [
        [null, 1_073_741_824, "< 1 GB"],
        [1_073_741_824, 5_368_709_120, "1–5 GB"],
        [5_368_709_120, 10_737_418_240, "5–10 GB"],
        [10_737_418_240, 21_474_836_480, "10–20 GB"],
        [21_474_836_480, null, "20+ GB"],
      ],
    },
  },
  {
    id: "duration", label: "Duration", group: "File", dbField: "duration", category: "numeric_bucket", nullLabel: "Unknown",
    bucketConfig: {
      ranges: [
        [null, 1_800_000, "< 30 min"],
        [1_800_000, 3_600_000, "30 min – 1 hr"],
        [3_600_000, 5_400_000, "1 – 1.5 hr"],
        [5_400_000, 7_200_000, "1.5 – 2 hr"],
        [7_200_000, null, "2+ hr"],
      ],
    },
  },
  // Dates
  {
    id: "addedAt", label: "Added Date", group: "Dates", dbField: "addedAt", category: "date_bucket", nullLabel: "Unknown",
    dateBucketGranularity: "month",
  },
  {
    id: "lastPlayedAt", label: "Last Played", group: "Dates", dbField: "lastPlayedAt", category: "date_bucket", nullLabel: "Never Played",
    dateBucketGranularity: "month",
  },
  {
    id: "originallyAvailableAt", label: "Release Date", group: "Dates", dbField: "originallyAvailableAt", category: "date_bucket", nullLabel: "Unknown",
    dateBucketGranularity: "month",
  },
  // Engagement
  {
    id: "rating", label: "Critic Rating", group: "Engagement", dbField: "rating", category: "numeric_bucket", nullLabel: "Unrated",
    bucketConfig: {
      ranges: [
        [null, 2, "0 – 2"],
        [2, 4, "2 – 4"],
        [4, 6, "4 – 6"],
        [6, 8, "6 – 8"],
        [8, null, "8 – 10"],
      ],
    },
  },
  {
    id: "audienceRating", label: "Audience Rating", group: "Engagement", dbField: "audienceRating", category: "numeric_bucket", nullLabel: "Unrated",
    bucketConfig: {
      ranges: [
        [null, 2, "0 – 2"],
        [2, 4, "2 – 4"],
        [4, 6, "4 – 6"],
        [6, 8, "6 – 8"],
        [8, null, "8 – 10"],
      ],
    },
  },
  {
    id: "playCount", label: "Play Count", group: "Engagement", dbField: "playCount", category: "numeric_bucket", nullLabel: "Unplayed",
    bucketConfig: {
      ranges: [
        [null, 1, "Unplayed"],
        [1, 5, "1 – 4"],
        [5, 10, "5 – 9"],
        [10, 25, "10 – 24"],
        [25, null, "25+"],
      ],
    },
  },
];

/** Bin raw resolution values to standard labels (4K, 1080P, 720P, 480P, SD) */
function normalizeResolutionBin(raw: string | null): string {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase().replace("p", "");
  const known: Record<string, string> = {
    "4k": "4K", "2160": "4K",
    "1080": "1080P",
    "720": "720P",
    "480": "480P",
    "360": "SD", sd: "SD",
  };
  if (known[lower]) return known[lower];
  const height = parseInt(lower, 10);
  if (!isNaN(height)) {
    if (height >= 2000) return "4K";
    if (height >= 900) return "1080P";
    if (height >= 600) return "720P";
    if (height >= 300) return "480P";
    return "SD";
  }
  return "Other";
}

export const DATE_DIMENSION_IDS = new Set<string>(
  DIMENSION_REGISTRY.filter((d) => d.category === "date_bucket").map((d) => d.id)
);

export function getDimensionMeta(id: string): DimensionMeta | undefined {
  return DIMENSION_REGISTRY.find((d) => d.id === id);
}

/** Group dimensions by their UI group for the config dialog select */
export function getDimensionsByGroup(): Map<string, DimensionMeta[]> {
  const groups = new Map<string, DimensionMeta[]>();
  for (const dim of DIMENSION_REGISTRY) {
    const list = groups.get(dim.group) ?? [];
    list.push(dim);
    groups.set(dim.group, list);
  }
  return groups;
}
