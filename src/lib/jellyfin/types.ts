/** Raw Jellyfin API response types */

export interface JellyfinPublicInfo {
  ServerName: string;
  Version: string;
  Id: string;
}

export interface JellyfinLibrary {
  Name: string;
  CollectionType?: string;
  ItemId: string;
  Locations: string[];
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  Overview?: string;
  Tagline?: string;
  OfficialRating?: string;
  CommunityRating?: number;
  CriticRating?: number;
  Studios?: { Name: string }[];
  GenreItems?: { Name: string; Id: string }[];
  Genres?: string[];
  People?: { Name: string; Role?: string; Type: string; Id?: string; PrimaryImageTag?: string }[];
  ProviderIds?: Record<string, string>;
  PremiereDate?: string;
  DateCreated?: string;
  RunTimeTicks?: number;
  SortName?: string;
  // Series/Episode
  SeriesName?: string;
  SeriesId?: string;
  SeasonName?: string;
  SeasonId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  // Music
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  AlbumArtists?: { Name: string; Id: string }[];
  // Images
  ImageTags?: Record<string, string>;
  ParentBackdropImageTags?: string[];
  SeriesPrimaryImageTag?: string;
  // User data
  UserData?: {
    PlayCount: number;
    IsFavorite: boolean;
    PlaybackPositionTicks: number;
    Played: boolean;
    LastPlayedDate?: string;
  };
  // Media streams
  MediaSources?: JellyfinMediaSource[];
  // Path
  Path?: string;
  // Container
  Container?: string;
}

export interface JellyfinMediaSource {
  Id: string;
  Name: string;
  Path?: string;
  Size?: number;
  Container?: string;
  Bitrate?: number;
  MediaStreams?: JellyfinMediaStream[];
  RunTimeTicks?: number;
}

export interface JellyfinMediaStream {
  Type: string; // "Video" | "Audio" | "Subtitle"
  Codec?: string;
  Profile?: string;
  Level?: number;
  Width?: number;
  Height?: number;
  BitRate?: number;
  BitDepth?: number;
  Channels?: number;
  SampleRate?: number;
  Language?: string;
  Title?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  Index: number;
  PixelFormat?: string;
  VideoRange?: string;
  VideoRangeType?: string;
  ColorPrimaries?: string;
  ColorSpace?: string;
  ColorTransfer?: string;
  AspectRatio?: string;
  RealFrameRate?: number;
  AverageFrameRate?: number;
  IsAnamorphic?: boolean;
  ChromaSubsampling?: string;
  ChannelLayout?: string;
  // Spatial audio (Jellyfin-specific)
  AudioSpatialFormat?: string; // "None" | "DolbyAtmos" | "DTSX"
  // Dolby Vision details
  DvProfile?: number;
  DvVersionMajor?: number;
  DvVersionMinor?: number;
  DvLevel?: number;
  DvBlSignalCompatibilityId?: number;
  RpuPresentFlag?: number;
  ElPresentFlag?: number;
  BlPresentFlag?: number;
  VideoDoViTitle?: string;
  // HDR10+
  Hdr10PlusPresentFlag?: boolean;
  // Scan type
  IsInterlaced?: boolean;
  // Subtitle accessibility
  IsHearingImpaired?: boolean;
  // Video rotation
  Rotation?: number;
}

export interface JellyfinSession {
  Id: string;
  UserId: string;
  UserName: string;
  Client: string;
  DeviceName: string;
  NowPlayingItem?: JellyfinItem;
  PlayState?: {
    PositionTicks?: number;
    CanSeek: boolean;
    IsPaused: boolean;
    IsMuted: boolean;
    VolumeLevel?: number;
    PlayMethod?: string;
  };
  TranscodingInfo?: {
    IsVideoDirect: boolean;
    IsAudioDirect: boolean;
    Bitrate?: number;
    CompletionPercentage?: number;
    TranscodeReasons?: string[];
  };
  RemoteEndPoint?: string;
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}
