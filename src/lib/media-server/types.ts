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
  userId: string;
  username: string;
  userThumb: string;
  title: string;
  parentTitle?: string;
  grandparentTitle?: string;
  type: string;
  year?: number;
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
    transcodeHwRequested?: boolean;
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
}
