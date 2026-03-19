export interface MediaItemWithRelations {
  id: string;
  libraryId: string;
  ratingKey: string;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  title: string;
  titleSort: string | null;
  year: number | null;
  type: string;
  summary: string | null;
  thumbUrl: string | null;
  artUrl: string | null;
  parentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  // Content metadata
  contentRating: string | null;
  rating: number | null;
  audienceRating: number | null;
  userRating: number | null;
  studio: string | null;
  tagline: string | null;
  originalTitle: string | null;
  originallyAvailableAt: string | null;
  viewOffset: number | null;
  // Tag arrays (JSON)
  genres: string[] | null;
  directors: string[] | null;
  writers: string[] | null;
  roles: Array<{ tag: string; role: string | null; thumb: string | null }> | null;
  countries: string[] | null;
  // Video metadata
  resolution: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  videoCodec: string | null;
  videoProfile: string | null;
  videoFrameRate: string | null;
  videoBitDepth: number | null;
  videoBitrate: number | null;
  videoColorPrimaries: string | null;
  videoColorRange: string | null;
  videoChromaSubsampling: string | null;
  aspectRatio: string | null;
  scanType: string | null;
  // Audio metadata
  audioCodec: string | null;
  audioChannels: number | null;
  audioProfile: string | null;
  audioBitrate: number | null;
  audioSamplingRate: number | null;
  // File metadata
  container: string | null;
  dynamicRange: string | null;
  optimizedForStreaming: boolean | null;
  fileSize: string | null; // BigInt serialized as string
  filePath: string | null;
  duration: number | null;
  // Playback
  playCount: number;
  lastPlayedAt: string | null;
  addedAt: string | null;
  createdAt: string;
  updatedAt: string;
  streams: {
    id: string;
    streamType: number;
    index: number | null;
    codec: string | null;
    profile: string | null;
    bitrate: number | null;
    isDefault: boolean;
    displayTitle: string | null;
    extendedDisplayTitle: string | null;
    language: string | null;
    languageCode: string | null;
    width: number | null;
    height: number | null;
    frameRate: number | null;
    scanType: string | null;
    colorPrimaries: string | null;
    colorRange: string | null;
    chromaSubsampling: string | null;
    bitDepth: number | null;
    videoRangeType: string | null;
    channels: number | null;
    samplingRate: number | null;
    audioChannelLayout: string | null;
    forced: boolean | null;
  }[];
  parentThumbUrl?: string | null;
  seasonThumbUrl?: string | null;
  matchedEpisodes?: number;
  library?: {
    title: string;
    mediaServer?: {
      id?: string;
      name: string;
      type?: string;
    };
  };
  servers?: Array<{
    serverId: string;
    serverName: string;
    serverType: string;
    mediaItemId?: string;
  }>;
  matchedBy?: string | null;
}
