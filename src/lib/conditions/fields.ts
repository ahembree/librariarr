import type { ConditionField } from "./types";

/**
 * Single source of truth for criterion fields, shared by the rule builder and
 * the query builder. Each field carries metadata flags (`requiresArr`,
 * `requiresSeerr`, `isSeriesAggregate`, `invalidForLibraryType`) that the
 * builders use to gate availability — no hardcoded `Set` membership checks.
 */
export const CONDITION_FIELDS: ConditionField[] = [
  // ─── Content ────────────────────────────────────────────────────────────
  { value: "title", label: "Title", type: "text", section: "content" },
  { value: "parentTitle", label: "Artist / Series", type: "text", section: "content" },
  { value: "albumTitle", label: "Album", type: "text", section: "content" },
  { value: "year", label: "Year", type: "number", section: "content" },
  { value: "contentRating", label: "Content Rating", type: "text", section: "content", enumerable: true },
  { value: "studio", label: "Studio", type: "text", section: "content", enumerable: true },
  { value: "genre", label: "Genre", type: "text", section: "content", enumerable: true },
  { value: "labels", label: "Label", type: "text", section: "content", enumerable: true },

  // ─── Activity ───────────────────────────────────────────────────────────
  { value: "playCount", label: "Play Count", type: "number", section: "activity" },
  { value: "watchedByUser", label: "Watched By User", type: "text", section: "activity", enumerable: true },
  { value: "rating", label: "Rating", type: "number", section: "activity" },
  { value: "audienceRating", label: "Audience Rating", type: "number", section: "activity" },
  { value: "ratingCount", label: "Rating Count", type: "number", section: "activity" },
  { value: "isWatchlisted", label: "Is Watchlisted", type: "boolean", section: "activity", knownValues: ["true", "false"] },
  { value: "lastPlayedAt", label: "Last Played", type: "date", section: "activity" },
  { value: "addedAt", label: "Date Added", type: "date", section: "activity" },
  { value: "originallyAvailableAt", label: "Release Date", type: "date", section: "activity" },

  // ─── Video ──────────────────────────────────────────────────────────────
  { value: "resolution", label: "Resolution", type: "text", section: "video", enumerable: true },
  { value: "videoCodec", label: "Video Codec", type: "text", section: "video", enumerable: true },
  { value: "videoProfile", label: "Video Profile", type: "text", section: "video", enumerable: true },
  { value: "dynamicRange", label: "Dynamic Range", type: "text", section: "video", enumerable: true, knownValues: ["Dolby Vision", "HDR10+", "HDR10", "HDR", "HLG", "SDR"] },
  { value: "videoBitDepth", label: "Video Bit Depth", type: "number", section: "video" },
  { value: "videoBitrate", label: "Video Bitrate (kbps)", type: "number", section: "video" },
  { value: "videoFrameRate", label: "Frame Rate", type: "text", section: "video", enumerable: true },
  { value: "aspectRatio", label: "Aspect Ratio", type: "text", section: "video", enumerable: true },
  { value: "scanType", label: "Scan Type", type: "text", section: "video", enumerable: true },

  // ─── Audio ──────────────────────────────────────────────────────────────
  { value: "audioCodec", label: "Audio Codec", type: "text", section: "audio", enumerable: true },
  { value: "audioProfile", label: "Audio Profile", type: "text", section: "audio", enumerable: true, knownValues: ["Dolby Atmos", "Dolby TrueHD", "DTS-HD MA", "DTS:X"] },
  { value: "audioChannels", label: "Audio Channels", type: "number", section: "audio" },
  { value: "audioSamplingRate", label: "Sample Rate (Hz)", type: "number", section: "audio" },
  { value: "audioBitrate", label: "Audio Bitrate (kbps)", type: "number", section: "audio" },

  // ─── Streams ────────────────────────────────────────────────────────────
  { value: "audioLanguage", label: "Audio Language", type: "text", section: "streams", enumerable: true },
  { value: "subtitleLanguage", label: "Subtitle Language", type: "text", section: "streams", enumerable: true },
  { value: "streamAudioCodec", label: "Stream Audio Codec", type: "text", section: "streams", enumerable: true },
  { value: "audioStreamCount", label: "Audio Track Count", type: "number", section: "streams" },
  { value: "subtitleStreamCount", label: "Subtitle Track Count", type: "number", section: "streams" },

  // ─── File ───────────────────────────────────────────────────────────────
  { value: "fileSize", label: "File Size (MB)", type: "number", section: "file" },
  { value: "container", label: "Container", type: "text", section: "file", enumerable: true },
  { value: "duration", label: "Duration (min)", type: "number", section: "file" },

  // ─── Cross-System ───────────────────────────────────────────────────────
  { value: "serverCount", label: "Server Count", type: "number", section: "cross" },
  { value: "matchedByRuleSet", label: "Matched By Rule Set", type: "text", section: "cross", enumerable: true },
  { value: "hasPendingAction", label: "Has Pending Action", type: "boolean", section: "cross", knownValues: ["true", "false"] },

  // ─── External IDs ───────────────────────────────────────────────────────
  { value: "hasExternalId", label: "Has External ID", type: "text", section: "external", enumerable: true, knownValues: ["TMDB", "TVDB", "IMDB", "MUSICBRAINZ"] },

  // ─── Arr: Status ────────────────────────────────────────────────────────
  { value: "foundInArr", label: "Found In Arr", type: "boolean", section: "arrStatus", knownValues: ["true", "false"], requiresArr: true },
  { value: "arrMonitored", label: "Monitored", type: "boolean", section: "arrStatus", knownValues: ["true", "false"], requiresArr: true },
  { value: "arrTag", label: "Tag", type: "text", section: "arrStatus", enumerable: true, requiresArr: true },
  { value: "arrQualityProfile", label: "Quality Profile", type: "text", section: "arrStatus", enumerable: true, requiresArr: true },
  { value: "arrQualityName", label: "Quality Name", type: "text", section: "arrStatus", enumerable: true, requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrQualityCutoffMet", label: "Quality Cutoff Met", type: "boolean", section: "arrStatus", knownValues: ["true", "false"], requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrCustomFormatScore", label: "Custom Format Score", type: "number", section: "arrStatus", requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrStatus", label: "Status", type: "text", section: "arrStatus", enumerable: true, requiresArr: true },
  { value: "arrEnded", label: "Ended", type: "boolean", section: "arrStatus", knownValues: ["true", "false"], requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrSeriesType", label: "Series Type", type: "text", section: "arrStatus", enumerable: true, requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },

  // ─── Arr: Media ─────────────────────────────────────────────────────────
  { value: "arrRating", label: "IMDB Rating", type: "number", section: "arrMedia", requiresArr: true },
  { value: "arrTmdbRating", label: "TMDB Rating", type: "number", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["MUSIC"] },
  { value: "arrRtCriticRating", label: "RT Critic Rating", type: "number", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["MUSIC"] },
  { value: "arrOriginalLanguage", label: "Original Language", type: "text", section: "arrMedia", enumerable: true, requiresArr: true, invalidForLibraryType: ["MUSIC"] },
  { value: "arrRuntime", label: "Runtime (min)", type: "number", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrSizeOnDisk", label: "Size on Disk (MB)", type: "number", section: "arrMedia", requiresArr: true },
  { value: "arrPath", label: "Path", type: "text", section: "arrMedia", requiresArr: true },
  { value: "arrReleaseDate", label: "Release Date", type: "date", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrInCinemasDate", label: "In Cinemas Date", type: "date", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },
  { value: "arrFirstAired", label: "First Aired", type: "date", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrDateAdded", label: "Date Added", type: "date", section: "arrMedia", requiresArr: true },
  { value: "arrDownloadDate", label: "Download Date", type: "date", section: "arrMedia", requiresArr: true, invalidForLibraryType: ["SERIES", "MUSIC"] },

  // ─── Arr: Episodes ──────────────────────────────────────────────────────
  { value: "arrSeasonCount", label: "Season Count", type: "number", section: "arrEpisodes", requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrEpisodeCount", label: "Episode Count", type: "number", section: "arrEpisodes", requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrHasUnaired", label: "Has Unaired", type: "boolean", section: "arrEpisodes", knownValues: ["true", "false"], requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrMonitoredSeasonCount", label: "Monitored Seasons", type: "number", section: "arrEpisodes", requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "arrMonitoredEpisodeCount", label: "Monitored Episodes", type: "number", section: "arrEpisodes", requiresArr: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },

  // ─── Seerr ──────────────────────────────────────────────────────────────
  { value: "seerrRequested", label: "Has Request", type: "boolean", section: "seerr", knownValues: ["true", "false"], requiresSeerr: true },
  { value: "seerrRequestDate", label: "Request Date", type: "date", section: "seerr", requiresSeerr: true },
  { value: "seerrRequestCount", label: "Request Count", type: "number", section: "seerr", requiresSeerr: true },
  { value: "seerrRequestedBy", label: "Requested By", type: "text", section: "seerr", enumerable: true, requiresSeerr: true },
  { value: "seerrApprovalDate", label: "Approval Date", type: "date", section: "seerr", requiresSeerr: true },
  { value: "seerrDeclineDate", label: "Decline Date", type: "date", section: "seerr", requiresSeerr: true },

  // ─── Series (aggregate fields, computed by aggregating across episodes) ─
  { value: "latestEpisodeViewDate", label: "Latest Episode View Date", type: "date", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "availableEpisodeCount", label: "Available Episode Count", type: "number", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "watchedEpisodeCount", label: "Watched Episode Count", type: "number", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "watchedEpisodePercentage", label: "Watched Episode %", type: "number", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "lastEpisodeAddedAt", label: "Last Episode Added", type: "date", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
  { value: "lastEpisodeAiredAt", label: "Last Episode Aired", type: "date", section: "series", isSeriesAggregate: true, invalidForLibraryType: ["MOVIE", "MUSIC"] },
];

/** Lookup a field by value. */
export function getConditionField(value: string): ConditionField | undefined {
  return CONDITION_FIELDS.find((f) => f.value === value);
}
