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

  // Paginated library fetching for memory-efficient sync.
  // `total` is the library-wide item count, or `null` when the server doesn't
  // report it — callers must NOT treat null as a number (it used to be a large
  // sentinel, which overflowed the Int SyncJob.totalItems column). When total is
  // null the caller relies on the short-page check to terminate paging.
  getLibraryItemsPage(
    sectionKey: string,
    type: LibraryItemType,
    offset: number,
    limit: number,
  ): Promise<{ items: MediaMetadataItem[]; total: number | null }>;

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
  /**
   * Push an on-screen message to a playing client WITHOUT stopping it — used
   * to warn a viewer before a delayed termination. Optional: only servers with
   * a client-message API implement it (Jellyfin/Emby). Plex has no way to
   * message a playing client short of terminating, so it leaves this undefined
   * and the "warning" there is simply the grace delay before termination.
   */
  notifySession?(sessionId: string, message: string): Promise<void>;

  // Image proxying
  getImageUrl(path: string): string;
  /**
   * Fetch artwork. `width` is a hint that the caller only needs the image at
   * that width — implementations that can have the media server resize before
   * sending should do so, since the alternative is transferring and decoding a
   * multi-megabyte original to produce a thumbnail. Honouring it is optional;
   * the result is resized locally regardless.
   */
  fetchImage(path: string, options?: { width?: number }): Promise<{ data: Buffer; contentType: string }>;

  // Optional: Plex-only methods
  getAccounts?(): Promise<Map<number, string>>;
  /**
   * Per-version source resolution (Media id → raw resolution string) for a
   * multi-version item. Plex-only; lets the 4K criterion match the exact
   * version being played.
   */
  getItemMediaResolutions?(ratingKey: string): Promise<Map<string, string>>;
  /** List known usernames on the server (for the excluded-users picker). */
  listUsernames?(): Promise<string[]>;
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
