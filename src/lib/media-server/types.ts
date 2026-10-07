// Canonical server-agnostic types.
// All media server clients (Plex, Jellyfin, Emby) normalize their responses into these shapes.

// --- Library Section ---

export interface MediaLibrarySection {
  key: string;
  title: string;
  type: string;
  agent: string;
  scanner: string;
}

// --- Media Stream ---

export interface MediaStream {
  id: number;
  index?: number;
  streamType: number; // 1=video, 2=audio, 3=subtitle, 4=lyrics
  codec?: string;
  profile?: string;
  level?: number;
  streamIdentifier?: number;
  bitrate?: number;
  default?: boolean;
  selected?: boolean;
  key?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  language?: string;
  languageCode?: string;
  // Video stream fields
  width?: number;
  height?: number;
  codedWidth?: string;
  codedHeight?: string;
  frameRate?: number;
  videoResolution?: string;
  scanType?: string;
  anamorphic?: string;
  refFrames?: number;
  hasScalingMatrix?: boolean;
  colorSpace?: string;
  colorRange?: string;
  colorTrc?: string;
  colorPrimaries?: string;
  chromaSubsampling?: string;
  chromaLocation?: string;
  bitDepth?: number;
  pixelFormat?: string;
  videoRange?: string;
  videoRangeType?: string;
  DOVIPresent?: boolean;
  DOVIBLPresent?: boolean;
  DOVIELPresent?: boolean;
  DOVIRPUPresent?: boolean;
  DOVIBLCompatID?: number;
  DOVILevel?: number;
  DOVIProfile?: number;
  DOVIVersion?: string;
  HDR10PlusPresent?: boolean;
  // Audio stream fields
  channels?: number;
  samplingRate?: number;
  audioChannelLayout?: string;
  audioSpatialFormat?: string;
  // Subtitle stream fields
  forced?: boolean;
  canAutoSync?: boolean;
  headerCompression?: string;
  title?: string;
}

// --- Media Part ---

export interface MediaPart {
  id: number;
  key: string;
  duration?: number;
  file?: string;
  size?: number;
  container?: string;
  has64bitOffsets?: boolean;
  optimizedForStreaming?: boolean;
  audioProfile?: string;
  videoProfile?: string;
  hasThumbnail?: string;
  indexes?: string;
  Stream?: MediaStream[];
}

// --- Media ---

export interface MediaInfo {
  id: number;
  duration?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  videoCodec?: string;
  videoResolution?: string;
  videoProfile?: string;
  videoFrameRate?: string;
  audioCodec?: string;
  audioChannels?: number;
  audioProfile?: string;
  container?: string;
  has64bitOffsets?: boolean;
  hasVoiceActivity?: boolean;
  optimizedForStreaming?: boolean;
  Part?: MediaPart[];
}

// --- Metadata Tag Objects ---

export interface MediaTag {
  id?: number;
  tag: string;
  tagKey?: string;
  filter?: string;
  thumb?: string;
}

export interface MediaRole extends MediaTag {
  role?: string;
}

// --- Metadata Item ---

export interface MediaMetadataItem {
  ratingKey: string;
  key: string;
  type: string;
  subtype?: string;
  title: string;
  titleSort?: string;
  originalTitle?: string;
  year?: number;
  summary?: string;
  tagline?: string;
  studio?: string;
  contentRating?: string;
  rating?: number;
  ratingImage?: string;
  audienceRating?: number;
  audienceRatingImage?: string;
  userRating?: number;
  ratingCount?: number;
  thumb?: string;
  art?: string;
  banner?: string;
  hero?: string;
  theme?: string;
  composite?: string;
  duration?: number;
  originallyAvailableAt?: string;
  addedAt?: number;
  updatedAt?: number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
  chapterSource?: string;
  primaryExtraKey?: string;
  skipChildren?: boolean;
  skipParent?: boolean;
  // TV Show specific
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  // Episode/Season specific
  parentKey?: string;
  parentRatingKey?: string;
  parentTitle?: string;
  parentIndex?: number;
  parentThumb?: string;
  parentHero?: string;
  grandparentKey?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  grandparentHero?: string;
  grandparentTheme?: string;
  index?: number;
  absoluteIndex?: number;
  // Library context
  librarySectionID?: number;
  librarySectionTitle?: string;
  // Nested objects
  Media?: MediaInfo[];
  Genre?: MediaTag[];
  Director?: MediaTag[];
  Writer?: MediaTag[];
  Role?: MediaRole[];
  Country?: MediaTag[];
  Label?: MediaTag[];
  Image?: Array<{ type: string; url: string; alt?: string }>;
  Rating?: Array<{ image: string; value: number; type: string }>;
  // External IDs (GUIDs) like "tmdb://12345", "tvdb://67890", "imdb://tt1234567"
  Guid?: Array<{ id: string }>;
  guid?: string;
  // Watchlist/Favorites status (from Jellyfin/Emby IsFavorite)
  isWatchlisted?: boolean;
}

// --- Collection ---

export interface MediaCollection {
  ratingKey: string;
  key: string;
  title: string;
  titleSort?: string;
  subtype: string;
  childCount?: number;
}

// --- Active Session ---

export interface MediaSession {
  sessionId: string;
  /**
   * The library item being played (Plex ratingKey / Jellyfin item id). Lets a
   * session be matched back to its synced MediaItem — needed because Plex
   * reports the *delivered stream* on a session, not the source file.
   */
  ratingKey?: string;
  /**
   * Plex only: the id of the specific Media version being played (a Plex item
   * can hold several versions at different resolutions). Lets the 4K criterion
   * resolve the exact version's source resolution rather than the single value
   * stored for the whole item.
   */
  mediaId?: string;
  userId: string;
  username: string;
  userThumb: string;
  title: string;
  parentTitle?: string;
  grandparentTitle?: string;
  type: string;
  year?: number;
  /** An episode's season and episode numbers — its SxxExx (episodes only). */
  seasonNumber?: number;
  episodeNumber?: number;
  thumb?: string;
  art?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  summary?: string;
  // Content metadata
  contentRating?: string;
  studio?: string;
  rating?: number;
  audienceRating?: number;
  tagline?: string;
  genres?: string[];
  // Media dimensions
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
  viewOffset?: number;
  // Media details
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  bitrate?: number;
  aspectRatio?: string;
  audioChannels?: number;
  videoResolution?: string;
  videoProfile?: string;
  audioProfile?: string;
  optimizedForStreaming?: boolean;
  // File info
  partFile?: string;
  partSize?: number;
  player: {
    product: string;
    platform: string;
    state: string;
    address: string;
    local: boolean;
  };
  session: {
    bandwidth: number;
    location: string;
  };
  transcoding?: {
    videoDecision: string;
    audioDecision: string;
    throttled: boolean;
    sourceVideoCodec?: string;
    sourceAudioCodec?: string;
    speed?: number;
    /**
     * Plex only, and only that hardware was *requested* — Plex falls back to
     * software silently, so never treat this as proof of acceleration. Use
     * hwDecode/hwEncode (or `isHardwareTranscode`) instead.
     */
    transcodeHwRequested?: boolean;
    /** Plex: acceleration API per half, e.g. "vaapi". Absent = software. */
    hwDecode?: string;
    hwEncode?: string;
    /** Plex: decode and encode both on hardware. */
    hwFullPipeline?: boolean;
  };
}

// --- Watch History ---

export interface WatchHistoryEntry {
  username: string;
  watchedAt: string | null;
}

export interface DetailedWatchHistoryEntry {
  ratingKey: string;
  username: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  /**
   * The library (`Library.key`) the play was recorded in, when the server
   * says (Plex `librarySectionID`). Only used to place a play whose rating key
   * matches items in more than one library of the server.
   */
  librarySectionKey?: string | null;
}

/**
 * Why `getDetailedWatchHistory` could not read one user's plays completely
 * (`DetailedWatchHistoryReport.incompleteUsers`). The caller acts on the two
 * differently, so the reason travels with the name.
 *
 * - `refused`: the server refused that user's listing (401/403/404). The key
 *   cannot read the user and will not be able to, so the history is still
 *   established without them, as it always was — waiting would block the
 *   server for good.
 * - `unreliable`: the listing answered, but in a shape that cannot be trusted
 *   to be complete — an empty first page under a non-zero total, or one far
 *   short of it — so by the server's own count the user has plays this run
 *   did not see. Their stored rows are kept and stand as the user's last
 *   reliable record; only a user with no stored rows on the server, while
 *   the history was not established when the run began, keeps it
 *   unestablished.
 */
export type IncompleteUserReason = "refused" | "unreliable";

/**
 * What a `getDetailedWatchHistory` call could not read, for a caller that
 * commits the result with a full replace. The caller creates it empty and the
 * client fills it in; a caller that passes none gets the stricter behaviour
 * described on each field instead.
 */
export interface DetailedWatchHistoryReport {
  /**
   * Users (by the name their plays are stored under) whose plays could not be
   * read completely this time, with why (`IncompleteUserReason`) — on
   * Jellyfin/Emby, a played-items listing the server refused or answered in a
   * shape that cannot be trusted to be complete. Such a user contributes NO
   * entries, and the caller must keep that user's stored rows rather than
   * replace them with nothing. Without a report, an untrustworthy listing
   * fails the whole fetch and a refused user is skipped.
   */
  incompleteUsers: Map<string, IncompleteUserReason>;
  /**
   * Plex: `/devices` could not be read, so every entry's `deviceName` and
   * `platform` are null for want of an answer — not because the play had no
   * device. The caller should keep the stored values rather than blank them.
   */
  devicesUnavailable: boolean;
}

export interface DetailedWatchHistoryOptions {
  /** See `MediaServerClient.getDetailedWatchHistory`. */
  since?: Date;
  /** See `DetailedWatchHistoryReport`. */
  report?: DetailedWatchHistoryReport;
}
