import type {
  MediaSession,
  MediaMetadataItem,
  MediaLibrarySection,
  MediaCollection,
  WatchHistoryEntry,
  DetailedWatchHistoryEntry,
} from "./types";

export type LibraryItemType = "movie" | "episode" | "track";

export interface MediaServerClientOptions {
  skipTlsVerify?: boolean;
}

/**
 * Shared interface for all media server clients (Plex, Jellyfin, Emby).
 * Required methods must be implemented by all server types.
 * Optional methods are Plex-only features.
 */
export interface MediaServerClient {
  /** Whether the bulk listing endpoint may return incomplete metadata requiring per-item enrichment */
  readonly bulkListingIncomplete?: boolean;

  // Connection
  testConnection(): Promise<{ ok: boolean; error?: string; serverName?: string }>;

  // Libraries
  getLibraries(): Promise<MediaLibrarySection[]>;
  getLibraryItems(sectionKey: string): Promise<MediaMetadataItem[]>;
  getLibraryShows(sectionKey: string): Promise<MediaMetadataItem[]>;
  getLibraryEpisodes(sectionKey: string): Promise<MediaMetadataItem[]>;
  getLibraryTracks(sectionKey: string): Promise<MediaMetadataItem[]>;

  // Paginated library fetching for memory-efficient sync
  getLibraryItemsPage(
    sectionKey: string,
    type: LibraryItemType,
    offset: number,
    limit: number,
  ): Promise<{ items: MediaMetadataItem[]; total: number }>;

  // Item metadata
  getItemMetadata(ratingKey: string): Promise<MediaMetadataItem>;

  // Watch data
  getWatchCounts(): Promise<
    Map<string, { count: number; lastWatchedAt: number }>
  >;
  getWatchHistory(
    ratingKey: string,
    itemDuration?: number
  ): Promise<WatchHistoryEntry[]>;
  getDetailedWatchHistory(): Promise<DetailedWatchHistoryEntry[]>;

  // Sessions
  getSessions(): Promise<MediaSession[]>;
  terminateSession(sessionId: string, reason: string): Promise<void>;

  // Image proxying
  getImageUrl(path: string): string;
  fetchImage(path: string): Promise<{ data: Buffer; contentType: string }>;

  // Optional: Plex-only methods
  getAccounts?(): Promise<Map<number, string>>;
  getCollections?(sectionKey: string): Promise<MediaCollection[]>;
  createCollection?(
    sectionKey: string,
    title: string,
    machineId: string,
    ratingKeys: string[],
    type: number
  ): Promise<MediaCollection>;
  getCollectionItems?(
    collectionRatingKey: string
  ): Promise<MediaMetadataItem[]>;
  addCollectionItems?(
    collectionRatingKey: string,
    machineId: string,
    ratingKeys: string[]
  ): Promise<void>;
  removeCollectionItem?(
    collectionRatingKey: string,
    ratingKey: string
  ): Promise<void>;
  deleteCollection?(collectionRatingKey: string): Promise<void>;
  renameCollection?(
    sectionKey: string,
    collectionRatingKey: string,
    newTitle: string
  ): Promise<void>;
  editCollectionSortTitle?(
    sectionKey: string,
    collectionRatingKey: string,
    sortTitle: string
  ): Promise<void>;
  getCollectionVisibility?(
    sectionKey: string,
    collectionRatingKey: string
  ): Promise<{
    identifier: string | null;
    home: boolean;
    shared: boolean;
    recommended: boolean;
  }>;
  updateCollectionVisibility?(
    sectionKey: string,
    collectionRatingKey: string,
    home: boolean,
    shared: boolean,
    recommended: boolean
  ): Promise<void>;
  getPrerollSetting?(): Promise<string>;
  setPrerollPath?(path: string): Promise<void>;
  clearPreroll?(): Promise<void>;
}
