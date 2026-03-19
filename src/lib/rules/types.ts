export type RuleField =
  | "playCount"
  | "lastPlayedAt"
  | "addedAt"
  | "resolution"
  | "videoCodec"
  | "audioCodec"
  | "videoBitrate"
  | "audioChannels"
  | "fileSize"
  | "year"
  | "title"
  | "container"
  | "dynamicRange"
  | "audioProfile"
  | "parentTitle"
  | "albumTitle"
  | "contentRating"
  | "studio"
  | "genre"
  | "rating"
  | "audienceRating"
  | "originallyAvailableAt"
  | "isWatchlisted"
  | "videoBitDepth"
  | "videoProfile"
  | "videoFrameRate"
  | "aspectRatio"
  | "scanType"
  | "audioSamplingRate"
  | "audioBitrate"
  | "audioLanguage"
  | "subtitleLanguage"
  | "streamAudioCodec"
  | "audioStreamCount"
  | "subtitleStreamCount"
  | "duration"
  | "hasExternalId"
  | "foundInArr"
  | "arrTag"
  | "arrQualityProfile"
  | "arrMonitored"
  | "arrRating"
  | "arrTmdbRating"
  | "arrRtCriticRating"
  | "arrDateAdded"
  | "arrPath"
  | "arrSizeOnDisk"
  | "arrOriginalLanguage"
  | "arrReleaseDate"
  | "arrInCinemasDate"
  | "arrRuntime"
  | "arrQualityName"
  | "arrQualityCutoffMet"
  | "arrDownloadDate"
  | "arrFirstAired"
  | "arrSeasonCount"
  | "arrEpisodeCount"
  | "arrStatus"
  | "arrEnded"
  | "arrSeriesType"
  | "arrHasUnaired"
  | "arrMonitoredSeasonCount"
  | "arrMonitoredEpisodeCount"
  | "seerrRequested"
  | "seerrRequestDate"
  | "seerrRequestCount"
  | "seerrRequestedBy"
  | "seerrApprovalDate"
  | "seerrDeclineDate"
  | "latestEpisodeViewDate"
  | "availableEpisodeCount"
  | "watchedEpisodeCount"
  | "watchedEpisodePercentage"
  | "lastEpisodeAddedAt"
  | "lastEpisodeAiredAt"
  | "serverCount"
  | "matchedByRuleSet"
  | "hasPendingAction"
  | StreamQueryField;

// Stream query fields — used inside stream query groups to filter individual stream records
export type StreamQueryField =
  | "sqCodec"
  | "sqProfile"
  | "sqLanguage"
  | "sqLanguageCode"
  | "sqChannels"
  | "sqBitrate"
  | "sqBitDepth"
  | "sqIsDefault"
  | "sqDisplayTitle"
  | "sqExtDisplayTitle"
  | "sqWidth"
  | "sqHeight"
  | "sqFrameRate"
  | "sqScanType"
  | "sqVideoRangeType"
  | "sqSamplingRate"
  | "sqAudioLayout"
  | "sqForced"
  | "sqAudioProfile"
  | "sqDynamicRange"
  | "sqColorPrimaries"
  | "sqColorRange"
  | "sqChromaSubsampling";

export type StreamQueryStreamType = "audio" | "video" | "subtitle";

export type RuleOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "contains"
  | "notContains"
  | "matchesWildcard"
  | "notMatchesWildcard"
  | "before"
  | "after"
  | "inLastDays"
  | "notInLastDays"
  | "isNull"
  | "isNotNull"
  | "between";

export type RuleCondition = "AND" | "OR";

export interface Rule {
  id: string;
  field: RuleField;
  operator: RuleOperator;
  value: string | number;
  condition: RuleCondition;
  negate?: boolean;
  enabled?: boolean;
}

export interface RuleGroup {
  id: string;
  name?: string;
  condition: RuleCondition; // How this group connects to previous sibling (ignored for first)
  operator?: RuleCondition; // Deprecated — per-rule conditions are used instead
  rules: Rule[];
  groups: RuleGroup[]; // Nested sub-groups (evaluated alongside rules using operator)
  enabled?: boolean;
  /** When set, this group is a stream query — rules apply to individual stream records */
  streamQuery?: {
    streamType: StreamQueryStreamType;
    /** Quantifier: "any" (default/EXISTS), "none" (NOT EXISTS), "all" (FORALL) */
    quantifier?: "any" | "none" | "all";
  };
}

export type RuleFieldSection = "content" | "activity" | "video" | "audio" | "file" | "streams" | "external" | "arrStatus" | "arrMedia" | "arrEpisodes" | "seerr" | "series" | "cross" | "streamQuery";

export interface RuleFieldDef {
  value: RuleField;
  label: string;
  type: "number" | "text" | "date" | "boolean";
  section: RuleFieldSection;
  enumerable?: boolean;
  knownValues?: string[];
}

export const FIELD_SECTIONS: { key: RuleFieldSection; label: string }[] = [
  { key: "content", label: "Content" },
  { key: "activity", label: "Activity" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "streams", label: "Streams" },
  { key: "file", label: "File" },
  { key: "cross", label: "Cross-System" },
  { key: "external", label: "External IDs" },
  { key: "arrStatus", label: "Arr: Status" },
  { key: "arrMedia", label: "Arr: Media" },
  { key: "arrEpisodes", label: "Arr: Episodes" },
  { key: "seerr", label: "Seerr" },
  { key: "series", label: "Series" },
];

export const RULE_FIELDS: RuleFieldDef[] = [
  // Content
  { value: "title", label: "Title", type: "text", section: "content" },
  { value: "parentTitle", label: "Artist / Series", type: "text", section: "content" },
  { value: "albumTitle", label: "Album", type: "text", section: "content" },
  { value: "year", label: "Year", type: "number", section: "content" },
  { value: "contentRating", label: "Content Rating", type: "text", section: "content", enumerable: true },
  { value: "studio", label: "Studio", type: "text", section: "content", enumerable: true },
  { value: "genre", label: "Genre", type: "text", section: "content", enumerable: true },
  // Activity
  { value: "playCount", label: "Play Count", type: "number", section: "activity" },
  { value: "rating", label: "Rating", type: "number", section: "activity" },
  { value: "audienceRating", label: "Audience Rating", type: "number", section: "activity" },
  { value: "isWatchlisted", label: "Is Watchlisted", type: "boolean", section: "activity", knownValues: ["true", "false"] },
  { value: "lastPlayedAt", label: "Last Played", type: "date", section: "activity" },
  { value: "addedAt", label: "Date Added", type: "date", section: "activity" },
  { value: "originallyAvailableAt", label: "Release Date", type: "date", section: "activity" },
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
  // Series
  { value: "latestEpisodeViewDate", label: "Latest Episode View Date", type: "date", section: "series" },
  { value: "availableEpisodeCount", label: "Available Episode Count", type: "number", section: "series" },
  { value: "watchedEpisodeCount", label: "Watched Episode Count", type: "number", section: "series" },
  { value: "watchedEpisodePercentage", label: "Watched Episode %", type: "number", section: "series" },
  { value: "lastEpisodeAddedAt", label: "Last Episode Added", type: "date", section: "series" },
  { value: "lastEpisodeAiredAt", label: "Last Episode Aired", type: "date", section: "series" },
];

export const ARR_FIELDS: RuleField[] = [
  "foundInArr",
  "arrTag", "arrQualityProfile", "arrMonitored", "arrRating",
  "arrTmdbRating", "arrRtCriticRating",
  "arrDateAdded", "arrPath", "arrSizeOnDisk", "arrOriginalLanguage",
  "arrReleaseDate", "arrInCinemasDate", "arrRuntime", "arrQualityName",
  "arrQualityCutoffMet", "arrDownloadDate",
  "arrFirstAired", "arrSeasonCount", "arrEpisodeCount", "arrStatus",
  "arrEnded", "arrSeriesType", "arrHasUnaired",
  "arrMonitoredSeasonCount", "arrMonitoredEpisodeCount",
];

export function isArrField(field: RuleField): boolean {
  return ARR_FIELDS.includes(field);
}

export const SEERR_FIELDS: RuleField[] = [
  "seerrRequested", "seerrRequestDate", "seerrRequestCount",
  "seerrRequestedBy", "seerrApprovalDate", "seerrDeclineDate",
];

export function isSeerrField(field: RuleField): boolean {
  return SEERR_FIELDS.includes(field);
}

export const STREAM_FIELDS: RuleField[] = [
  "audioLanguage", "subtitleLanguage", "streamAudioCodec",
  "audioStreamCount", "subtitleStreamCount",
];

export function isStreamField(field: RuleField): boolean {
  return STREAM_FIELDS.includes(field);
}

export function isExternalField(field: RuleField): boolean {
  return isArrField(field) || isSeerrField(field);
}

export const SERIES_AGGREGATE_FIELDS: RuleField[] = [
  "latestEpisodeViewDate", "availableEpisodeCount",
  "watchedEpisodeCount", "watchedEpisodePercentage",
  "lastEpisodeAddedAt", "lastEpisodeAiredAt",
];

export function isSeriesAggregateField(field: RuleField): boolean {
  return SERIES_AGGREGATE_FIELDS.includes(field);
}

export const CROSS_SYSTEM_FIELDS = new Set<string>([
  "serverCount", "matchedByRuleSet", "hasPendingAction",
]);

export function isCrossSystemField(field: string): boolean {
  return CROSS_SYSTEM_FIELDS.has(field);
}

export const RULE_OPERATORS: {
  value: RuleOperator;
  label: string;
  dateLabel?: string;
  types: ("number" | "text" | "date" | "boolean")[];
}[] = [
  { value: "equals", label: "Equals", dateLabel: "Is On", types: ["number", "text", "date", "boolean"] },
  { value: "notEquals", label: "Not Equals", dateLabel: "Is Not On", types: ["number", "text", "date", "boolean"] },
  { value: "greaterThan", label: "Greater Than", types: ["number"] },
  { value: "greaterThanOrEqual", label: "Greater Than or Equal", types: ["number"] },
  { value: "lessThan", label: "Less Than", types: ["number"] },
  { value: "lessThanOrEqual", label: "Less Than or Equal", types: ["number"] },
  { value: "contains", label: "Contains", types: ["text"] },
  { value: "notContains", label: "Not Contains", types: ["text"] },
  { value: "matchesWildcard", label: "Matches Wildcard", types: ["text"] },
  { value: "notMatchesWildcard", label: "Not Matches Wildcard", types: ["text"] },
  { value: "before", label: "Is Before", types: ["date"] },
  { value: "after", label: "Is After", types: ["date"] },
  { value: "inLastDays", label: "In Last X Days", types: ["date"] },
  { value: "notInLastDays", label: "More Than X Days Ago", types: ["date"] },
  { value: "between", label: "Between", types: ["number", "date"] },
  { value: "isNull", label: "Is Empty", types: ["number", "text", "date"] },
  { value: "isNotNull", label: "Is Not Empty", types: ["number", "text", "date"] },
];

// --- Stream Query Field Definitions ---

/** Which stream types each stream query field applies to */
const SQ_STREAM_TYPE_MAP: Record<StreamQueryField, StreamQueryStreamType[]> = {
  sqCodec: ["audio", "video", "subtitle"],
  sqProfile: ["audio", "video", "subtitle"],
  sqLanguage: ["audio", "video", "subtitle"],
  sqLanguageCode: ["audio", "video", "subtitle"],
  sqBitrate: ["audio", "video"],
  sqIsDefault: ["audio", "video", "subtitle"],
  sqDisplayTitle: ["audio", "video", "subtitle"],
  sqExtDisplayTitle: ["audio", "video", "subtitle"],
  sqChannels: ["audio"],
  sqSamplingRate: ["audio"],
  sqAudioLayout: ["audio"],
  sqAudioProfile: ["audio"],
  sqBitDepth: ["video"],
  sqWidth: ["video"],
  sqHeight: ["video"],
  sqFrameRate: ["video"],
  sqScanType: ["video"],
  sqVideoRangeType: ["video"],
  sqDynamicRange: ["video"],
  sqColorPrimaries: ["video"],
  sqColorRange: ["video"],
  sqChromaSubsampling: ["video"],
  sqForced: ["subtitle"],
};

/** Maps stream query field names to MediaStream column names (null = computed) */
const SQ_COLUMN_MAP: Record<StreamQueryField, string | null> = {
  sqCodec: "codec",
  sqProfile: "profile",
  sqLanguage: "language",
  sqLanguageCode: "languageCode",
  sqChannels: "channels",
  sqBitrate: "bitrate",
  sqBitDepth: "bitDepth",
  sqIsDefault: "isDefault",
  sqDisplayTitle: "displayTitle",
  sqExtDisplayTitle: "extendedDisplayTitle",
  sqWidth: "width",
  sqHeight: "height",
  sqFrameRate: "frameRate",
  sqScanType: "scanType",
  sqVideoRangeType: "videoRangeType",
  sqSamplingRate: "samplingRate",
  sqAudioLayout: "audioChannelLayout",
  sqForced: "forced",
  sqAudioProfile: null, // computed
  sqDynamicRange: null, // computed
  sqColorPrimaries: "colorPrimaries",
  sqColorRange: "colorRange",
  sqChromaSubsampling: "chromaSubsampling",
};

export const STREAM_QUERY_COMPUTED_FIELDS: StreamQueryField[] = ["sqAudioProfile", "sqDynamicRange"];

export function isStreamQueryComputedField(field: string): boolean {
  return STREAM_QUERY_COMPUTED_FIELDS.includes(field as StreamQueryField);
}

export const STREAM_QUERY_FIELDS: RuleFieldDef[] = [
  { value: "sqCodec", label: "Codec", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqProfile", label: "Profile", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqLanguage", label: "Language", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqLanguageCode", label: "Language Code", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqChannels", label: "Channels", type: "number", section: "streamQuery" },
  { value: "sqBitrate", label: "Bitrate (kbps)", type: "number", section: "streamQuery" },
  { value: "sqBitDepth", label: "Bit Depth", type: "number", section: "streamQuery" },
  { value: "sqIsDefault", label: "Is Default Track", type: "boolean", section: "streamQuery", knownValues: ["true", "false"] },
  { value: "sqDisplayTitle", label: "Display Title", type: "text", section: "streamQuery" },
  { value: "sqExtDisplayTitle", label: "Extended Display Title", type: "text", section: "streamQuery" },
  { value: "sqWidth", label: "Width", type: "number", section: "streamQuery" },
  { value: "sqHeight", label: "Height", type: "number", section: "streamQuery" },
  { value: "sqFrameRate", label: "Frame Rate", type: "number", section: "streamQuery" },
  { value: "sqScanType", label: "Scan Type", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqVideoRangeType", label: "Video Range Type", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqSamplingRate", label: "Sample Rate (Hz)", type: "number", section: "streamQuery" },
  { value: "sqAudioLayout", label: "Channel Layout", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqForced", label: "Forced", type: "boolean", section: "streamQuery", knownValues: ["true", "false"] },
  { value: "sqAudioProfile", label: "Audio Profile", type: "text", section: "streamQuery", enumerable: true, knownValues: ["Dolby Atmos", "DTS:X", "DTS-HD MA", "Dolby TrueHD"] },
  { value: "sqDynamicRange", label: "Dynamic Range", type: "text", section: "streamQuery", enumerable: true, knownValues: ["Dolby Vision", "HDR10+", "HDR10", "HDR", "HLG", "SDR"] },
  { value: "sqColorPrimaries", label: "Color Primaries", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqColorRange", label: "Color Range", type: "text", section: "streamQuery", enumerable: true },
  { value: "sqChromaSubsampling", label: "Chroma Subsampling", type: "text", section: "streamQuery", enumerable: true },
];

export const STREAM_QUERY_SECTIONS: { key: string; label: string }[] = [
  { key: "streamQuery", label: "Stream Properties" },
];

export const ALL_STREAM_QUERY_FIELD_VALUES: StreamQueryField[] =
  STREAM_QUERY_FIELDS.map((f) => f.value as StreamQueryField);

export function isStreamQueryField(field: string): boolean {
  return ALL_STREAM_QUERY_FIELD_VALUES.includes(field as StreamQueryField);
}

export function isStreamQueryGroup(group: { streamQuery?: unknown }): boolean {
  return !!group.streamQuery;
}

/** Returns stream query fields applicable to the given stream type */
export function getStreamQueryFieldsForType(streamType: StreamQueryStreamType): RuleFieldDef[] {
  return STREAM_QUERY_FIELDS.filter((f) =>
    SQ_STREAM_TYPE_MAP[f.value as StreamQueryField]?.includes(streamType),
  );
}

/** Maps a stream query field to its MediaStream column name, or null if computed */
export function streamQueryFieldToColumn(field: StreamQueryField): string | null {
  return SQ_COLUMN_MAP[field] ?? null;
}

export const STREAM_TYPE_INT_MAP: Record<StreamQueryStreamType, number> = {
  video: 1,
  audio: 2,
  subtitle: 3,
};
