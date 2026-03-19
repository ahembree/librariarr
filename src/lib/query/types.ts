import type { RuleOperator, RuleCondition } from "@/lib/rules/types";

// Re-export operator/condition types shared with the rule engine
export type { RuleOperator, RuleCondition };

/** A single query condition — like Rule but with field: string for the extended field set. */
export interface QueryRule {
  id: string;
  field: string;
  operator: string; // RuleOperator | "isNull" | "isNotNull"
  value: string | number;
  condition: RuleCondition;
  negate?: boolean;
  enabled?: boolean;
}

/** A recursive group of query conditions — mirrors RuleGroup but uses QueryRule. */
export interface QueryGroup {
  id: string;
  name?: string;
  condition: RuleCondition;
  operator?: RuleCondition; // Deprecated — per-rule conditions are used instead
  rules: QueryRule[];
  groups: QueryGroup[];
  enabled?: boolean;
  /** When set, this group is a stream query — rules apply to individual stream records */
  streamQuery?: { streamType: string; quantifier?: "any" | "none" | "all" };
}

export type QueryFieldSection =
  | "content"
  | "video"
  | "audio"
  | "streams"
  | "file"
  | "activity"
  | "cross"
  | "external"
  | "arrStatus"
  | "arrMedia"
  | "arrEpisodes"
  | "seerr";

export interface QueryFieldDef {
  value: string;
  label: string;
  type: "number" | "text" | "date" | "boolean";
  section: QueryFieldSection;
  enumerable?: boolean;
  knownValues?: string[];
}

export const QUERY_FIELD_SECTIONS: { key: QueryFieldSection; label: string }[] = [
  { key: "content", label: "Content" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "streams", label: "Streams" },
  { key: "file", label: "File" },
  { key: "activity", label: "Activity" },
  { key: "cross", label: "Cross-System" },
  { key: "external", label: "External IDs" },
  { key: "arrStatus", label: "Arr: Status" },
  { key: "arrMedia", label: "Arr: Media" },
  { key: "arrEpisodes", label: "Arr: Episodes" },
  { key: "seerr", label: "Seerr" },
];

export const QUERY_FIELDS: QueryFieldDef[] = [
  // Content
  { value: "title", label: "Title", type: "text", section: "content" },
  { value: "parentTitle", label: "Artist / Series", type: "text", section: "content" },
  { value: "albumTitle", label: "Album", type: "text", section: "content" },
  { value: "year", label: "Year", type: "number", section: "content" },
  { value: "contentRating", label: "Content Rating", type: "text", section: "content", enumerable: true },
  { value: "studio", label: "Studio", type: "text", section: "content", enumerable: true },
  { value: "genre", label: "Genre", type: "text", section: "content", enumerable: true },
  { value: "labels", label: "Label", type: "text", section: "content", enumerable: true },
  // Video
  { value: "resolution", label: "Resolution", type: "text", section: "video", enumerable: true },
  { value: "videoCodec", label: "Video Codec", type: "text", section: "video", enumerable: true },
  { value: "videoProfile", label: "Video Profile", type: "text", section: "video", enumerable: true },
  { value: "dynamicRange", label: "Dynamic Range", type: "text", section: "video", enumerable: true, knownValues: ["Dolby Vision", "HDR10+", "HDR10", "HDR", "HLG", "SDR"] },
  { value: "videoBitDepth", label: "Video Bit Depth", type: "number", section: "video" },
  { value: "videoBitrate", label: "Video Bitrate (kbps)", type: "number", section: "video" },
  { value: "videoFrameRate", label: "Frame Rate", type: "text", section: "video", enumerable: true },
  { value: "aspectRatio", label: "Aspect Ratio", type: "text", section: "video", enumerable: true },
  { value: "scanType", label: "Scan Type", type: "text", section: "video", enumerable: true },
  // Audio
  { value: "audioCodec", label: "Audio Codec", type: "text", section: "audio", enumerable: true },
  { value: "audioProfile", label: "Audio Profile", type: "text", section: "audio", enumerable: true, knownValues: ["Dolby Atmos", "Dolby TrueHD", "DTS-HD MA", "DTS:X"] },
  { value: "audioChannels", label: "Audio Channels", type: "number", section: "audio" },
  { value: "audioSamplingRate", label: "Sample Rate (Hz)", type: "number", section: "audio" },
  { value: "audioBitrate", label: "Audio Bitrate (kbps)", type: "number", section: "audio" },
  // Streams
  { value: "audioLanguage", label: "Audio Language", type: "text", section: "streams", enumerable: true },
  { value: "subtitleLanguage", label: "Subtitle Language", type: "text", section: "streams", enumerable: true },
  { value: "streamAudioCodec", label: "Stream Audio Codec", type: "text", section: "streams", enumerable: true },
  { value: "audioStreamCount", label: "Audio Track Count", type: "number", section: "streams" },
  { value: "subtitleStreamCount", label: "Subtitle Track Count", type: "number", section: "streams" },
  // File
  { value: "fileSize", label: "File Size (MB)", type: "number", section: "file" },
  { value: "container", label: "Container", type: "text", section: "file", enumerable: true },
  { value: "duration", label: "Duration (min)", type: "number", section: "file" },
  // Activity
  { value: "playCount", label: "Play Count", type: "number", section: "activity" },
  { value: "rating", label: "Rating", type: "number", section: "activity" },
  { value: "audienceRating", label: "Audience Rating", type: "number", section: "activity" },
  { value: "ratingCount", label: "Rating Count", type: "number", section: "activity" },
  { value: "isWatchlisted", label: "Is Watchlisted", type: "boolean", section: "activity", knownValues: ["true", "false"] },
  { value: "lastPlayedAt", label: "Last Played", type: "date", section: "activity" },
  { value: "addedAt", label: "Date Added", type: "date", section: "activity" },
  { value: "originallyAvailableAt", label: "Release Date", type: "date", section: "activity" },
  // Cross-System
  { value: "serverCount", label: "Server Count", type: "number", section: "cross" },
  { value: "matchedByRuleSet", label: "Matched By Rule Set", type: "text", section: "cross", enumerable: true },
  { value: "hasPendingAction", label: "Has Pending Action", type: "boolean", section: "cross", knownValues: ["true", "false"] },
  // External IDs
  { value: "hasExternalId", label: "Has External ID", type: "text", section: "external", enumerable: true, knownValues: ["TMDB", "TVDB", "IMDB", "MUSICBRAINZ"] },
  // Arr: Status
  { value: "foundInArr", label: "Found In Arr", type: "boolean", section: "arrStatus", knownValues: ["true", "false"] },
  { value: "arrMonitored", label: "Monitored", type: "boolean", section: "arrStatus", knownValues: ["true", "false"] },
  { value: "arrTag", label: "Tag", type: "text", section: "arrStatus", enumerable: true },
  { value: "arrQualityProfile", label: "Quality Profile", type: "text", section: "arrStatus", enumerable: true },
  { value: "arrQualityName", label: "Quality Name", type: "text", section: "arrStatus", enumerable: true },
  { value: "arrQualityCutoffMet", label: "Quality Cutoff Met", type: "boolean", section: "arrStatus", knownValues: ["true", "false"] },
  { value: "arrStatus", label: "Status", type: "text", section: "arrStatus", enumerable: true },
  { value: "arrEnded", label: "Ended", type: "boolean", section: "arrStatus", knownValues: ["true", "false"] },
  { value: "arrSeriesType", label: "Series Type", type: "text", section: "arrStatus", enumerable: true },
  // Arr: Media
  { value: "arrRating", label: "IMDB Rating", type: "number", section: "arrMedia" },
  { value: "arrTmdbRating", label: "TMDB Rating", type: "number", section: "arrMedia" },
  { value: "arrRtCriticRating", label: "RT Critic Rating", type: "number", section: "arrMedia" },
  { value: "arrOriginalLanguage", label: "Original Language", type: "text", section: "arrMedia", enumerable: true },
  { value: "arrRuntime", label: "Runtime (min)", type: "number", section: "arrMedia" },
  { value: "arrSizeOnDisk", label: "Size on Disk (MB)", type: "number", section: "arrMedia" },
  { value: "arrPath", label: "Path", type: "text", section: "arrMedia" },
  { value: "arrReleaseDate", label: "Release Date", type: "date", section: "arrMedia" },
  { value: "arrInCinemasDate", label: "In Cinemas Date", type: "date", section: "arrMedia" },
  { value: "arrFirstAired", label: "First Aired", type: "date", section: "arrMedia" },
  { value: "arrDateAdded", label: "Date Added", type: "date", section: "arrMedia" },
  { value: "arrDownloadDate", label: "Download Date", type: "date", section: "arrMedia" },
  // Arr: Episodes
  { value: "arrSeasonCount", label: "Season Count", type: "number", section: "arrEpisodes" },
  { value: "arrEpisodeCount", label: "Episode Count", type: "number", section: "arrEpisodes" },
  { value: "arrHasUnaired", label: "Has Unaired", type: "boolean", section: "arrEpisodes", knownValues: ["true", "false"] },
  { value: "arrMonitoredSeasonCount", label: "Monitored Seasons", type: "number", section: "arrEpisodes" },
  { value: "arrMonitoredEpisodeCount", label: "Monitored Episodes", type: "number", section: "arrEpisodes" },
  // Seerr
  { value: "seerrRequested", label: "Has Request", type: "boolean", section: "seerr", knownValues: ["true", "false"] },
  { value: "seerrRequestDate", label: "Request Date", type: "date", section: "seerr" },
  { value: "seerrRequestCount", label: "Request Count", type: "number", section: "seerr" },
  { value: "seerrRequestedBy", label: "Requested By", type: "text", section: "seerr", enumerable: true },
  { value: "seerrApprovalDate", label: "Approval Date", type: "date", section: "seerr" },
  { value: "seerrDeclineDate", label: "Decline Date", type: "date", section: "seerr" },
];

export const QUERY_OPERATORS: {
  value: string;
  label: string;
  dateLabel?: string;
  types: ("number" | "text" | "date" | "boolean")[];
}[] = [
  { value: "equals", label: "Equals", dateLabel: "Is On", types: ["number", "text", "date", "boolean"] },
  { value: "notEquals", label: "Not Equals", dateLabel: "Is Not On", types: ["number", "text", "date", "boolean"] },
  { value: "greaterThan", label: "Greater Than", types: ["number"] },
  { value: "greaterThanOrEqual", label: ">=", types: ["number"] },
  { value: "lessThan", label: "Less Than", types: ["number"] },
  { value: "lessThanOrEqual", label: "<=", types: ["number"] },
  { value: "contains", label: "Contains", types: ["text"] },
  { value: "notContains", label: "Not Contains", types: ["text"] },
  { value: "matchesWildcard", label: "Matches Wildcard", types: ["text"] },
  { value: "notMatchesWildcard", label: "Not Matches Wildcard", types: ["text"] },
  { value: "before", label: "Is Before", types: ["date"] },
  { value: "after", label: "Is After", types: ["date"] },
  { value: "inLastDays", label: "In Last X Days", types: ["date"] },
  { value: "notInLastDays", label: "More Than X Days Ago", types: ["date"] },
  { value: "between", label: "Between", dateLabel: "Between", types: ["number", "date"] },
  { value: "isNull", label: "Is Empty", types: ["number", "text", "date"] },
  { value: "isNotNull", label: "Is Not Empty", types: ["number", "text", "date"] },
];

export interface QueryDefinition {
  mediaTypes: ("MOVIE" | "SERIES" | "MUSIC")[];
  serverIds: string[];
  groups: QueryGroup[];
  sortBy: string;
  sortOrder: "asc" | "desc";
  includeEpisodes?: boolean;
  arrServerIds?: {
    radarr?: string;
    sonarr?: string;
    lidarr?: string;
  };
  seerrInstanceId?: string;
}

// Fields that require special handling (not direct MediaItem columns)
export const STREAM_FIELDS = new Set(["audioLanguage", "subtitleLanguage", "streamAudioCodec", "audioStreamCount", "subtitleStreamCount"]);
export const GENRE_FIELD = "genre";
export const LABELS_FIELD = "labels";
export const EXTERNAL_ID_FIELD = "hasExternalId";

export const ARR_QUERY_FIELDS = new Set([
  "foundInArr",
  "arrTag", "arrQualityProfile", "arrMonitored", "arrRating", "arrTmdbRating", "arrRtCriticRating",
  "arrDateAdded", "arrPath", "arrSizeOnDisk", "arrOriginalLanguage",
  "arrReleaseDate", "arrInCinemasDate", "arrRuntime", "arrQualityName",
  "arrQualityCutoffMet", "arrDownloadDate",
  "arrFirstAired", "arrSeasonCount", "arrEpisodeCount", "arrStatus",
  "arrEnded", "arrSeriesType", "arrHasUnaired",
  "arrMonitoredSeasonCount", "arrMonitoredEpisodeCount",
]);
export const SEERR_QUERY_FIELDS = new Set([
  "seerrRequested", "seerrRequestDate", "seerrRequestCount",
  "seerrRequestedBy", "seerrApprovalDate", "seerrDeclineDate",
]);

export const CROSS_SYSTEM_QUERY_FIELDS = new Set([
  "serverCount", "matchedByRuleSet", "hasPendingAction",
]);

export function isCrossSystemQueryField(field: string): boolean {
  return CROSS_SYSTEM_QUERY_FIELDS.has(field);
}

export function isExternalQueryField(field: string): boolean {
  return ARR_QUERY_FIELDS.has(field) || SEERR_QUERY_FIELDS.has(field);
}

/** Walk group tree and return true if any rule references an Arr field */
export function hasArrRules(groups: QueryGroup[]): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (group.rules.some((r) => r.enabled !== false && ARR_QUERY_FIELDS.has(r.field))) return true;
    if (group.groups?.length && hasArrRules(group.groups)) return true;
  }
  return false;
}

/** Walk group tree and return true if any rule references a cross-system field */
export function hasCrossSystemRules(groups: QueryGroup[]): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (group.rules.some((r) => r.enabled !== false && CROSS_SYSTEM_QUERY_FIELDS.has(r.field))) return true;
    if (group.groups?.length && hasCrossSystemRules(group.groups)) return true;
  }
  return false;
}

/** Walk group tree and return true if any rule references a Seerr field */
export function hasSeerrRules(groups: QueryGroup[]): boolean {
  for (const group of groups) {
    if (group.enabled === false) continue;
    if (group.rules.some((r) => r.enabled !== false && SEERR_QUERY_FIELDS.has(r.field))) return true;
    if (group.groups?.length && hasSeerrRules(group.groups)) return true;
  }
  return false;
}
