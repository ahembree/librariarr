import axios, { type AxiosInstance } from "axios";
import https from "https";
import { configureRetry } from "@/lib/http-retry";
import type { MediaServerClient, MediaServerClientOptions, LibraryItemType } from "./client";
import type {
  MediaSession,
  MediaMetadataItem,
  MediaLibrarySection,
  MediaInfo,
  MediaPart,
  MediaStream,
  MediaTag,
  MediaRole,
  WatchHistoryEntry,
} from "./types";
import type {
  JellyfinItem,
  JellyfinLibrary,
  JellyfinMediaSource,
  JellyfinMediaStream,
  JellyfinSession,
  JellyfinItemsResponse,
} from "@/lib/jellyfin/types";
import { logger } from "@/lib/logger";
import { normalizeResolutionFromDimensions } from "@/lib/resolution";

// Fields to request from Jellyfin/Emby /Items endpoint (must be valid ItemFields enum values)
export const ITEM_FIELDS = [
  "Overview",
  "Genres",
  "Studios",
  "ProviderIds",
  "DateCreated",
  "MediaSources",
  "MediaStreams",
  "People",
  "Path",
  "Taglines",
  "OriginalTitle",
].join(",");

function mapLibraryType(collectionType?: string): string | null {
  switch (collectionType) {
    case "movies":
      return "movie";
    case "tvshows":
      return "show";
    case "music":
      return "artist";
    default:
      return null;
  }
}

function mapItemType(type: string): string {
  switch (type) {
    case "Movie":
      return "movie";
    case "Series":
      return "show";
    case "Season":
      return "season";
    case "Episode":
      return "episode";
    case "MusicArtist":
      return "artist";
    case "MusicAlbum":
      return "album";
    case "Audio":
      return "track";
    default:
      return type.toLowerCase();
  }
}

function ticksToMs(ticks?: number): number | undefined {
  if (ticks == null) return undefined;
  return Math.round(ticks / 10000);
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function isoToDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  return iso.substring(0, 10);
}

function mapStreamType(type: string): number {
  switch (type) {
    case "Video":
      return 1;
    case "Audio":
      return 2;
    case "Subtitle":
      return 3;
    default:
      return 0;
  }
}

/**
 * Shared base class for Jellyfin and Emby clients.
 * Both APIs are nearly identical (Jellyfin forked from Emby).
 * Subclasses override auth header format and log prefix.
 */
export abstract class JellyfinCompatClient implements MediaServerClient {
  readonly bulkListingIncomplete = false;
  protected readonly baseURL: string;
  protected readonly token: string;
  protected readonly client: AxiosInstance;
  private cachedUserId: string | null = null;

  protected abstract getAuthHeaders(): Record<string, string>;
  protected abstract get logPrefix(): string;

  constructor(
    baseURL: string,
    token: string,
    options?: MediaServerClientOptions
  ) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.token = token;

    const axiosConfig: Record<string, unknown> = {
      baseURL: this.baseURL,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 30000,
    };

    if (options?.skipTlsVerify) {
      axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    this.client = axios.create(axiosConfig);

    // Auth headers added via interceptor — safe because requests only fire
    // after the subclass constructor has completed.
    this.client.interceptors.request.use((config) => {
      Object.assign(config.headers, this.getAuthHeaders());
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      logger.debug(
        this.logPrefix,
        `${config.method?.toUpperCase()} ${config.url}`
      );
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        const start = (
          response.config as unknown as Record<string, unknown>
        ).__startTime as number;
        const duration = start ? Date.now() - start : 0;
        logger.debug(
          this.logPrefix,
          `${response.status} ${response.config.url} (${duration}ms)`
        );
        return response;
      },
      (error) => {
        if (axios.isAxiosError(error)) {
          const body = error.response?.data;
          const detail = typeof body === "string"
            ? body
            : body?.message ?? body?.title ?? body?.Message ?? body?.Title;
          logger.debug(
            this.logPrefix,
            `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}`,
            { message: error.message, ...(detail ? { detail } : {}) }
          );
        }
        return Promise.reject(error);
      }
    );

    configureRetry(this.client, () => this.logPrefix, logger);
  }

  // ----------------------------------------------------------------
  // MediaServerClient implementation
  // ----------------------------------------------------------------

  async testConnection(): Promise<{ ok: boolean; error?: string; serverName?: string }> {
    try {
      // First hit the public endpoint to check connectivity and get server name
      const publicResponse = await this.client.get("/System/Info/Public");
      if (!publicResponse.data?.ServerName) {
        return { ok: false, error: `This does not appear to be a ${this.logPrefix} server` };
      }
      const serverName = publicResponse.data.ServerName as string;

      // Now hit an authenticated endpoint to verify the API key is valid
      // /System/Info requires authentication, unlike /System/Info/Public
      try {
        await this.client.get("/System/Info");
      } catch (authError) {
        if (axios.isAxiosError(authError) && authError.response?.status === 401) {
          return { ok: false, error: "Authentication failed — invalid API key" };
        }
        if (axios.isAxiosError(authError) && authError.response?.status === 403) {
          return { ok: false, error: "Authorization failed — API key does not have admin privileges" };
        }
        throw authError;
      }

      return { ok: true, serverName };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === "ECONNREFUSED")
          return {
            ok: false,
            error: "Connection refused - server may be offline",
          };
        if (error.code === "ENOTFOUND")
          return {
            ok: false,
            error: "DNS lookup failed - hostname could not be resolved",
          };
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
          return { ok: false, error: "Connection timed out" };
        if (
          error.code === "ERR_TLS_CERT_ALTNAME_MISMATCH" ||
          error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
          error.message?.includes("certificate")
        ) {
          return {
            ok: false,
            error:
              "TLS certificate verification failed - enable 'Skip TLS Verification' for self-signed certificates",
          };
        }
        if (error.response?.status === 401)
          return {
            ok: false,
            error: "Authentication failed - invalid API key",
          };
        // 404 on /System/Info/Public likely means this isn't a Jellyfin/Emby server
        if (error.response?.status === 404)
          return {
            ok: false,
            error: `This does not appear to be a ${this.logPrefix} server — check your server type selection`,
          };
        return { ok: false, error: error.message };
      }
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Get the admin/authenticated user's ID. Required for /Items queries.
   * Cached after first call.
   */
  protected async getUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;

    // Try /Users/Me first (Jellyfin user access tokens).
    // Emby does not have this endpoint (returns 500 "Unrecognized Guid format"),
    // and Jellyfin API keys return 400. Fall through to /Users on any failure.
    try {
      const response = await this.client.get<{ Id: string }>("/Users/Me");
      this.cachedUserId = response.data.Id;
      return this.cachedUserId;
    } catch {
      // Fall through to /Users list fallback
    }

    // Fallback: list users and pick the first admin
    const usersRes = await this.client.get<
      Array<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }>
    >("/Users");
    const users = usersRes.data || [];
    const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
    if (!admin) {
      throw new Error("No users found on server — cannot determine userId for API queries");
    }
    logger.debug(this.logPrefix, `Using user "${admin.Name}" for API queries (API key auth)`);
    this.cachedUserId = admin.Id;
    return this.cachedUserId;
  }

  async getLibraries(): Promise<MediaLibrarySection[]> {
    const response = await this.client.get("/Library/VirtualFolders");
    const folders: JellyfinLibrary[] = response.data || [];
    return folders
      .map((f) => {
        const type = mapLibraryType(f.CollectionType);
        if (!type) return null;
        return {
          key: f.ItemId,
          title: f.Name,
          type,
          agent: "jellyfin",
          scanner: "jellyfin",
        } satisfies MediaLibrarySection;
      })
      .filter((x): x is MediaLibrarySection => x !== null);
  }

  async getLibraryItems(sectionKey: string): Promise<MediaMetadataItem[]> {
    return this.fetchItems(sectionKey, "Movie");
  }

  async getLibraryShows(sectionKey: string): Promise<MediaMetadataItem[]> {
    return this.fetchItems(sectionKey, "Series");
  }

  async getLibraryEpisodes(sectionKey: string): Promise<MediaMetadataItem[]> {
    return this.fetchItems(sectionKey, "Episode");
  }

  async getLibraryTracks(sectionKey: string): Promise<MediaMetadataItem[]> {
    return this.fetchItems(sectionKey, "Audio");
  }

  async getLibraryItemsPage(
    sectionKey: string,
    type: LibraryItemType,
    offset: number,
    limit: number,
  ): Promise<{ items: MediaMetadataItem[]; total: number }> {
    const itemTypes = type === "movie" ? "Movie" : type === "episode" ? "Episode" : "Audio";
    const userId = await this.getUserId();

    const response = await this.client.get<JellyfinItemsResponse>(`/Items`, {
      params: {
        UserId: userId,
        ParentId: sectionKey,
        Recursive: true,
        Fields: ITEM_FIELDS,
        EnableUserData: true,
        IncludeItemTypes: itemTypes,
        StartIndex: offset,
        Limit: limit,
      },
      timeout: 120000,
    });

    const items = (response.data.Items || []).map((item) => this.normalizeItem(item));
    const total = response.data.TotalRecordCount;
    return { items, total };
  }

  async getItemMetadata(ratingKey: string): Promise<MediaMetadataItem> {
    const userId = await this.getUserId();
    const response = await this.client.get<JellyfinItem>(
      `/Items/${ratingKey}`,
      {
        params: { UserId: userId, Fields: ITEM_FIELDS },
      }
    );
    return this.normalizeItem(response.data);
  }

  async getWatchCounts(): Promise<
    Map<string, { count: number; lastWatchedAt: number }>
  > {
    // Jellyfin items include UserData.PlayCount during normal item queries,
    // so the sync engine gets accurate counts directly from item normalization.
    return new Map();
  }

  async getWatchHistory(
    ratingKey: string
  ): Promise<WatchHistoryEntry[]> {
    try {
      // Get all users to check per-user play status
      const usersRes = await this.client.get<
        Array<{ Id: string; Name: string }>
      >("/Users");
      const users = usersRes.data || [];

      const entries: WatchHistoryEntry[] = [];

      for (const user of users) {
        try {
          const itemRes = await this.client.get<JellyfinItem>(
            `/Items/${ratingKey}`,
            { params: { UserId: user.Id } }
          );
          const userData = itemRes.data.UserData;
          if (userData && userData.PlayCount > 0) {
            for (let i = 0; i < userData.PlayCount; i++) {
              entries.push({
                username: user.Name,
                watchedAt:
                  i === 0 && userData.LastPlayedDate
                    ? new Date(userData.LastPlayedDate).toISOString()
                    : null,
              });
            }
          }
        } catch {
          // Skip users where we can't access the item
        }
      }

      return entries.sort((a, b) => {
        if (!a.watchedAt && !b.watchedAt) return 0;
        if (!a.watchedAt) return 1;
        if (!b.watchedAt) return -1;
        return (
          new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime()
        );
      });
    } catch {
      return [];
    }
  }

  async getDetailedWatchHistory(): Promise<
    Array<{
      ratingKey: string;
      username: string;
      watchedAt: string | null;
      deviceName: string | null;
      platform: string | null;
    }>
  > {
    const entries: Array<{
      ratingKey: string;
      username: string;
      watchedAt: string | null;
      deviceName: string | null;
      platform: string | null;
    }> = [];

    try {
      const usersRes = await this.client.get<
        Array<{ Id: string; Name: string }>
      >("/Users");
      const users = usersRes.data || [];

      for (const user of users) {
        try {
          const itemsRes = await this.client.get<{
            Items: Array<{
              Id: string;
              UserData?: { PlayCount?: number; LastPlayedDate?: string };
            }>;
          }>(`/Users/${user.Id}/Items`, {
            params: {
              IsPlayed: true,
              Recursive: true,
              Fields: "UserData",
              Limit: 10000,
            },
          });

          const items = itemsRes.data.Items || [];
          for (const item of items) {
            const playCount = item.UserData?.PlayCount ?? 0;
            if (playCount <= 0) continue;

            for (let i = 0; i < playCount; i++) {
              entries.push({
                ratingKey: item.Id,
                username: user.Name,
                watchedAt:
                  i === 0 && item.UserData?.LastPlayedDate
                    ? new Date(item.UserData.LastPlayedDate).toISOString()
                    : null,
                deviceName: null,
                platform: null,
              });
            }
          }
        } catch {
          // Skip users where we can't access items
        }
      }
    } catch {
      // Non-fatal
    }

    return entries;
  }

  async getSessions(): Promise<MediaSession[]> {
    try {
      const response =
        await this.client.get<JellyfinSession[]>("/Sessions");
      const sessions = response.data || [];
      return sessions
        .filter((s) => s.NowPlayingItem)
        .map((s) => this.normalizeSession(s));
    } catch (error) {
      logger.debug(this.logPrefix, "Failed to fetch sessions", {
        error: String(error),
      });
      return [];
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.client.post(`/Sessions/${sessionId}/Playing/Stop`);
  }

  getImageUrl(path: string): string {
    // path may be a full Jellyfin image path (e.g. "/Items/{id}/Images/Primary")
    // or just an item ID.
    if (path.startsWith("/")) {
      return `${this.baseURL}${path}${path.includes("?") ? "&" : "?"}api_key=${this.token}`;
    }
    return `${this.baseURL}/Items/${path}/Images/Primary?api_key=${this.token}`;
  }

  async fetchImage(path: string): Promise<{ data: Buffer; contentType: string }> {
    // Use the internal axios client (fixed baseURL + auth headers) to avoid SSRF.
    // Only accept relative paths starting with "/".
    const relativePath = path.startsWith("/") ? path : `/Items/${path}/Images/Primary`;
    const response = await this.client.get(relativePath, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    return {
      data: Buffer.from(response.data),
      contentType: response.headers["content-type"] || "image/jpeg",
    };
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  private async fetchItems(
    parentId: string,
    itemTypes?: string
  ): Promise<MediaMetadataItem[]> {
    const userId = await this.getUserId();
    const params: Record<string, string | number | boolean> = {
      UserId: userId,
      ParentId: parentId,
      Recursive: true,
      Fields: ITEM_FIELDS,
      EnableUserData: true,
    };
    if (itemTypes) params.IncludeItemTypes = itemTypes;

    const items: JellyfinItem[] = [];
    let startIndex = 0;
    const pageSize = 500;

    while (true) {
      const response = await this.client.get<JellyfinItemsResponse>(
        `/Items`,
        {
          params: { ...params, StartIndex: startIndex, Limit: pageSize },
          timeout: 120000, // 2 minutes for large library fetches
        }
      );
      const page = response.data.Items || [];
      items.push(...page);
      if (page.length < pageSize) break;
      startIndex += pageSize;
    }

    return items.map((item) => this.normalizeItem(item));
  }

  // ----------------------------------------------------------------
  // Normalization — Jellyfin → Plex-compatible shapes
  // ----------------------------------------------------------------

  protected normalizeItem(item: JellyfinItem): MediaMetadataItem {
    const guids: Array<{ id: string }> = [];
    if (item.ProviderIds) {
      // Case-insensitive lookup — Emby/Jellyfin may use different casing
      const providers = new Map(
        Object.entries(item.ProviderIds).map(([k, v]) => [k.toLowerCase(), v])
      );
      const tmdb = providers.get("tmdb");
      const tvdb = providers.get("tvdb");
      const imdb = providers.get("imdb");
      if (tmdb) guids.push({ id: `tmdb://${tmdb}` });
      if (tvdb) guids.push({ id: `tvdb://${tvdb}` });
      if (imdb) guids.push({ id: `imdb://${imdb}` });
    }

    const genreSource =
      item.GenreItems ?? item.Genres?.map((g) => ({ Name: g, Id: "" })) ?? [];
    const genres: MediaTag[] = genreSource.map((g) => ({ tag: g.Name }));

    const people = item.People ?? [];
    const roles: MediaRole[] = people
      .filter((p) => p.Type === "Actor")
      .map((p) => ({
        tag: p.Name,
        role: p.Role ?? "",
        thumb: p.Id && p.PrimaryImageTag ? `/Items/${p.Id}/Images/Primary` : undefined,
      }));
    const directors: MediaTag[] = people
      .filter((p) => p.Type === "Director")
      .map((p) => ({ tag: p.Name }));
    const writers: MediaTag[] = people
      .filter((p) => p.Type === "Writer")
      .map((p) => ({ tag: p.Name }));

    const media: MediaInfo[] | undefined = item.MediaSources?.map((src) =>
      this.normalizeMediaSource(src)
    );

    const thumb = item.ImageTags?.Primary
      ? `/Items/${item.Id}/Images/Primary`
      : undefined;
    const art =
      item.ParentBackdropImageTags?.length && item.SeriesId
        ? `/Items/${item.SeriesId}/Images/Backdrop`
        : item.ImageTags?.Primary
          ? `/Items/${item.Id}/Images/Backdrop`
          : undefined;

    return {
      ratingKey: item.Id,
      key: `/Items/${item.Id}`,
      type: mapItemType(item.Type),
      title: item.Name,
      year: item.ProductionYear,
      summary: item.Overview,
      tagline: item.Tagline,
      studio: item.Studios?.[0]?.Name,
      contentRating: item.OfficialRating,
      rating: item.CommunityRating,
      audienceRating:
        item.CriticRating != null ? item.CriticRating / 10 : undefined,
      thumb,
      art,
      duration: ticksToMs(item.RunTimeTicks),
      originallyAvailableAt: isoToDate(item.PremiereDate),
      addedAt: isoToEpoch(item.DateCreated),
      viewCount: item.UserData?.PlayCount,
      lastViewedAt: isoToEpoch(item.UserData?.LastPlayedDate),
      isWatchlisted: item.UserData?.IsFavorite ?? false,
      // Episode/Season context (also covers Music: Album → parentTitle, Artist → grandparentTitle)
      parentTitle: item.SeasonName ?? item.Album,
      parentRatingKey: item.SeasonId ?? item.AlbumId,
      parentIndex: item.ParentIndexNumber,
      grandparentTitle: item.SeriesName ?? item.AlbumArtist,
      grandparentRatingKey: item.SeriesId ?? item.AlbumArtists?.[0]?.Id,
      parentThumb: item.SeasonId
        ? `/Items/${item.SeasonId}/Images/Primary`
        : item.AlbumId
          ? `/Items/${item.AlbumId}/Images/Primary`
          : undefined,
      grandparentThumb:
        item.SeriesId && item.SeriesPrimaryImageTag
          ? `/Items/${item.SeriesId}/Images/Primary`
          : item.AlbumArtists?.[0]?.Id
            ? `/Items/${item.AlbumArtists[0].Id}/Images/Primary`
            : undefined,
      index: item.IndexNumber,
      titleSort: item.SortName,
      // Nested objects
      Media: media,
      Genre: genres.length > 0 ? genres : undefined,
      Director: directors.length > 0 ? directors : undefined,
      Writer: writers.length > 0 ? writers : undefined,
      Role: roles.length > 0 ? roles : undefined,
      Guid: guids.length > 0 ? guids : undefined,
    } satisfies MediaMetadataItem;
  }

  private normalizeMediaSource(src: JellyfinMediaSource): MediaInfo {
    const streams: MediaStream[] = (src.MediaStreams ?? []).map((s) =>
      this.normalizeStream(s)
    );

    const videoStream = src.MediaStreams?.find((s) => s.Type === "Video");
    const audioStream = src.MediaStreams?.find((s) => s.Type === "Audio");

    const part: MediaPart = {
      id: 0,
      key: "",
      file: src.Path,
      size: src.Size,
      container: src.Container,
      duration: ticksToMs(src.RunTimeTicks),
      Stream: streams,
    };

    return {
      id: 0,
      duration: ticksToMs(src.RunTimeTicks),
      bitrate: src.Bitrate ? Math.round(src.Bitrate / 1000) : undefined,
      width: videoStream?.Width,
      height: videoStream?.Height,
      videoCodec: videoStream?.Codec,
      videoResolution: normalizeResolutionFromDimensions(
        videoStream?.Width,
        videoStream?.Height
      ),
      videoProfile: videoStream?.Profile,
      audioCodec: audioStream?.Codec,
      audioChannels: audioStream?.Channels,
      container: src.Container,
      Part: [part],
    } satisfies MediaInfo;
  }

  private normalizeStream(s: JellyfinMediaStream): MediaStream {
    const hasDovi =
      s.DvProfile != null ||
      s.RpuPresentFlag === 1 ||
      s.BlPresentFlag === 1 ||
      s.ElPresentFlag === 1;

    return {
      id: s.Index,
      index: s.Index,
      streamType: mapStreamType(s.Type),
      codec: s.Codec,
      profile: s.Profile,
      level: s.Level,
      bitrate: s.BitRate ? Math.round(s.BitRate / 1000) : undefined,
      default: s.IsDefault,
      displayTitle: s.DisplayTitle,
      language: s.Language,
      title: s.Title,
      // Video
      width: s.Width,
      height: s.Height,
      frameRate: s.RealFrameRate ?? s.AverageFrameRate,
      bitDepth: s.BitDepth,
      pixelFormat: s.PixelFormat,
      videoRange: s.VideoRange,
      videoRangeType: s.VideoRangeType,
      colorPrimaries: s.ColorPrimaries,
      colorSpace: s.ColorSpace,
      colorTrc: s.ColorTransfer,
      chromaSubsampling: s.ChromaSubsampling,
      anamorphic: s.IsAnamorphic ? "1" : undefined,
      scanType:
        s.IsInterlaced === true
          ? "interlaced"
          : s.IsInterlaced === false
            ? "progressive"
            : undefined,
      // Dolby Vision details
      DOVIPresent: hasDovi || undefined,
      DOVIProfile: s.DvProfile,
      DOVILevel: s.DvLevel,
      DOVIBLCompatID: s.DvBlSignalCompatibilityId,
      DOVIRPUPresent: s.RpuPresentFlag === 1 || undefined,
      DOVIELPresent: s.ElPresentFlag === 1 || undefined,
      DOVIBLPresent: s.BlPresentFlag === 1 || undefined,
      DOVIVersion:
        s.VideoDoViTitle ??
        (s.DvVersionMajor != null
          ? `${s.DvVersionMajor}.${s.DvVersionMinor ?? 0}`
          : undefined),
      // HDR10+
      HDR10PlusPresent: s.Hdr10PlusPresentFlag ?? undefined,
      // Audio
      channels: s.Channels,
      samplingRate: s.SampleRate,
      audioChannelLayout: s.ChannelLayout,
      audioSpatialFormat:
        s.AudioSpatialFormat && s.AudioSpatialFormat !== "None"
          ? s.AudioSpatialFormat
          : undefined,
      // Subtitle
      forced: s.IsForced,
    } satisfies MediaStream;
  }

  private normalizeSession(s: JellyfinSession): MediaSession {
    const item = s.NowPlayingItem!;
    const playState = s.PlayState;
    const transcoding = s.TranscodingInfo;

    return {
      sessionId: s.Id,
      userId: s.UserId,
      username: s.UserName,
      userThumb: "",
      title: item.Name,
      parentTitle: item.SeasonName,
      grandparentTitle: item.SeriesName,
      type: mapItemType(item.Type),
      year: item.ProductionYear,
      thumb: item.ImageTags?.Primary
        ? `/Items/${item.Id}/Images/Primary`
        : undefined,
      grandparentThumb:
        item.SeriesId && item.SeriesPrimaryImageTag
          ? `/Items/${item.SeriesId}/Images/Primary`
          : undefined,
      duration: ticksToMs(item.RunTimeTicks),
      viewOffset: ticksToMs(playState?.PositionTicks),
      player: {
        product: s.Client,
        platform: s.DeviceName,
        state: playState?.IsPaused ? "paused" : "playing",
        address: s.RemoteEndPoint ?? "",
        local: false,
      },
      session: {
        bandwidth: 0,
        location: s.RemoteEndPoint ? "wan" : "lan",
      },
      ...(transcoding && {
        transcoding: {
          videoDecision: transcoding.IsVideoDirect ? "copy" : "transcode",
          audioDecision: transcoding.IsAudioDirect ? "copy" : "transcode",
          throttled: false,
          speed:
            transcoding.CompletionPercentage != null ? 1 : undefined,
        },
      }),
    } satisfies MediaSession;
  }
}
