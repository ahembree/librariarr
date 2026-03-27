import axios, { type AxiosInstance } from "axios";
import https from "https";
import { configureRetry } from "@/lib/http-retry";
import type {
  PlexLibrarySection,
  PlexMetadataItem,
  PlexCollection,
  PlexManagedHub,
  PlexSession,
} from "./types";
import type { MediaServerClient, LibraryItemType } from "@/lib/media-server/client";
import { logger } from "@/lib/logger";

export interface PlexClientOptions {
  skipTlsVerify?: boolean;
}

export class PlexClient implements MediaServerClient {
  readonly bulkListingIncomplete = true;
  private client: AxiosInstance;
  private baseURL: string;
  private token: string;

  constructor(baseURL: string, token: string, options?: PlexClientOptions) {
    this.baseURL = baseURL;
    this.token = token;
    const axiosConfig: Record<string, unknown> = {
      baseURL,
      headers: {
        "X-Plex-Token": token,
        Accept: "application/json",
      },
      timeout: 30000,
    };

    // Only skip TLS verification if the user explicitly opted in
    if (options?.skipTlsVerify) {
      axiosConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
    }

    this.client = axios.create(axiosConfig);

    this.client.interceptors.request.use((config) => {
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      if (!config.url?.includes("/library/metadata/")) {
        logger.debug("Plex", `${config.method?.toUpperCase()} ${config.url}`);
      }
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        const start = (response.config as unknown as Record<string, unknown>).__startTime as number;
        const duration = start ? Date.now() - start : 0;
        if (!response.config.url?.includes("/library/metadata/")) {
          logger.debug("Plex", `${response.status} ${response.config.url} (${duration}ms)`);
        }
        return response;
      },
      (error) => {
        if (axios.isAxiosError(error)) {
          logger.debug("Plex", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}`, {
            message: error.message,
          });
        }
        return Promise.reject(error);
      }
    );

    configureRetry(this.client, "Plex", logger);
  }

  async getLibraries(): Promise<PlexLibrarySection[]> {
    const response = await this.client.get("/library/sections");
    const directories = response.data.MediaContainer.Directory || [];
    return directories.filter(
      (dir: PlexLibrarySection) =>
        dir.type === "movie" || dir.type === "show" || dir.type === "artist"
    );
  }

  async getLibraryItems(sectionKey: string): Promise<PlexMetadataItem[]> {
    const response = await this.client.get(
      `/library/sections/${sectionKey}/all`,
      {
        params: { includeGuids: 1 },
      }
    );
    return response.data.MediaContainer.Metadata || [];
  }

  /**
   * Fetches all episodes in a TV library using the standard library listing
   * with type=4 (episode). This is more reliable than /allLeaves for
   * returning user-specific watch data (viewCount, lastViewedAt) and
   * also more efficient (single API call vs per-series).
   */
  /**
   * Fetches all shows in a TV library using type=2 (show).
   * Used to get show-level metadata (genres, studio, etc.) that
   * isn't available on episode-level items.
   */
  async getLibraryShows(sectionKey: string): Promise<PlexMetadataItem[]> {
    const response = await this.client.get(
      `/library/sections/${sectionKey}/all`,
      {
        params: { type: 2, includeGuids: 1 },
      }
    );
    return response.data.MediaContainer.Metadata || [];
  }

  async getLibraryEpisodes(sectionKey: string): Promise<PlexMetadataItem[]> {
    const response = await this.client.get(
      `/library/sections/${sectionKey}/all`,
      {
        params: { type: 4, includeGuids: 1 },
      }
    );
    return response.data.MediaContainer.Metadata || [];
  }

  /**
   * Fetches all tracks in a music library using the standard library listing
   * with type=10 (track). Mirrors getLibraryEpisodes pattern.
   */
  async getLibraryTracks(sectionKey: string): Promise<PlexMetadataItem[]> {
    const response = await this.client.get(
      `/library/sections/${sectionKey}/all`,
      {
        params: { type: 10, includeGuids: 1 },
      }
    );
    return response.data.MediaContainer.Metadata || [];
  }

  async getLibraryItemsPage(
    sectionKey: string,
    type: LibraryItemType,
    offset: number,
    limit: number,
  ): Promise<{ items: PlexMetadataItem[]; total: number }> {
    const typeParam = type === "episode" ? 4 : type === "track" ? 10 : undefined;
    const params: Record<string, unknown> = {
      includeGuids: 1,
      "X-Plex-Container-Start": offset,
      "X-Plex-Container-Size": limit,
    };
    if (typeParam) params.type = typeParam;

    const response = await this.client.get(
      `/library/sections/${sectionKey}/all`,
      { params },
    );

    const container = response.data.MediaContainer;
    const items = container.Metadata || [];
    const total = container.totalSize ?? container.size ?? items.length;
    return { items, total };
  }

  async getItemMetadata(ratingKey: string): Promise<PlexMetadataItem> {
    const response = await this.client.get(
      `/library/metadata/${ratingKey}`
    );
    return response.data.MediaContainer.Metadata[0];
  }

  async getAccounts(): Promise<Map<number, string>> {
    try {
      const response = await this.client.get("/accounts");
      const accounts =
        response.data.MediaContainer.Account || [];
      const map = new Map<number, string>();
      for (const acct of accounts) {
        map.set(acct.id, acct.name);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async getWatchHistory(
    ratingKey: string,
    itemDuration?: number
  ): Promise<
    Array<{
      username: string;
      watchedAt: string | null;
    }>
  > {
    const [response, accountMap] = await Promise.all([
      this.client.get("/status/sessions/history/all", {
        params: { metadataItemID: ratingKey, sort: "viewedAt:desc" },
      }),
      this.getAccounts(),
    ]);
    const metadata = response.data.MediaContainer.Metadata || [];
    const fullPlays = metadata.filter((entry: Record<string, unknown>) => {
      const viewOffset = entry.viewOffset as number | undefined;
      if (viewOffset == null || viewOffset === 0) return true;
      const duration = (entry.duration as number | undefined) ?? itemDuration;
      if (!duration || duration === 0) return true;
      return viewOffset / duration >= 0.9;
    });
    return fullPlays.map(
      (entry: Record<string, unknown>) => ({
        username:
          (entry.accountID != null
            ? accountMap.get(entry.accountID as number)
            : undefined) ??
          (entry.User as Record<string, string>)?.title ??
          "Unknown",
        watchedAt: entry.viewedAt
          ? new Date((entry.viewedAt as number) * 1000).toISOString()
          : null,
      })
    );
  }

  /**
   * Fetches server-wide watch history and returns per-ratingKey play counts.
   * Unlike viewCount (which is per-authenticated-user), this counts watches
   * from ALL users on the server — important for lifecycle decisions.
   */
  async getWatchCounts(): Promise<Map<string, { count: number; lastWatchedAt: number }>> {
    const counts = new Map<string, { count: number; lastWatchedAt: number }>();

    try {
      const PAGE_SIZE = 5000;
      let start = 0;

      while (true) {
        const response = await this.client.get("/status/sessions/history/all", {
          params: {
            sort: "viewedAt:desc",
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": PAGE_SIZE,
          },
        });
        const metadata = response.data.MediaContainer.Metadata || [];
        if (metadata.length === 0) break;

        for (const entry of metadata) {
          const key = String(entry.ratingKey ?? "");
          if (!key) continue;

          // Only count full plays (90%+ watched)
          const viewOffset = entry.viewOffset as number | undefined;
          if (viewOffset != null && viewOffset > 0) {
            const duration = entry.duration as number | undefined;
            if (duration && duration > 0 && viewOffset / duration < 0.9) {
              continue;
            }
          }

          const viewedAt = (entry.viewedAt as number) ?? 0;
          const existing = counts.get(key);
          if (existing) {
            existing.count++;
            if (viewedAt > existing.lastWatchedAt) {
              existing.lastWatchedAt = viewedAt;
            }
          } else {
            counts.set(key, { count: 1, lastWatchedAt: viewedAt });
          }
        }

        if (metadata.length < PAGE_SIZE) break;
        start += PAGE_SIZE;

        // Yield between pages so V8 can collect the previous page's parsed JSON
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    } catch {
      // Non-fatal: if history fetch fails, viewCount from metadata is used as-is
      logger.debug("Plex", "Failed to fetch watch history counts, using metadata viewCount only");
    }

    return counts;
  }

  async getDevices(): Promise<Map<number, { name: string; platform: string }>> {
    try {
      const response = await this.client.get("/devices");
      const devices = response.data.MediaContainer.Device || [];
      const map = new Map<number, { name: string; platform: string }>();
      for (const device of devices) {
        map.set(device.id, { name: device.name || "Unknown", platform: device.platform || "" });
      }
      return map;
    } catch {
      return new Map();
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
      const [accountMap, deviceMap] = await Promise.all([
        this.getAccounts(),
        this.getDevices(),
      ]);

      const PAGE_SIZE = 5000;
      let start = 0;

      while (true) {
        const response = await this.client.get("/status/sessions/history/all", {
          params: {
            sort: "viewedAt:desc",
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": PAGE_SIZE,
          },
        });
        const metadata = response.data.MediaContainer.Metadata || [];
        if (metadata.length === 0) break;

        for (const entry of metadata) {
          const key = String(entry.ratingKey ?? "");
          if (!key) continue;

          // Only count full plays (90%+ watched)
          const viewOffset = entry.viewOffset as number | undefined;
          if (viewOffset != null && viewOffset > 0) {
            const duration = entry.duration as number | undefined;
            if (duration && duration > 0 && viewOffset / duration < 0.9) {
              continue;
            }
          }

          const username =
            (entry.accountID != null
              ? accountMap.get(entry.accountID as number)
              : undefined) ?? "Unknown";

          const device = entry.deviceID != null
            ? deviceMap.get(entry.deviceID as number)
            : undefined;

          entries.push({
            ratingKey: key,
            username,
            watchedAt: entry.viewedAt
              ? new Date((entry.viewedAt as number) * 1000).toISOString()
              : null,
            deviceName: device?.name ?? null,
            platform: device?.platform ?? null,
          });
        }

        if (metadata.length < PAGE_SIZE) break;
        start += PAGE_SIZE;

        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    } catch {
      logger.debug("Plex", "Failed to fetch detailed watch history");
    }

    return entries;
  }

  // --- Collection Management ---

  async getCollections(sectionKey: string): Promise<PlexCollection[]> {
    const response = await this.client.get(
      `/library/sections/${sectionKey}/collections`
    );
    return response.data.MediaContainer.Metadata || [];
  }

  async createCollection(
    sectionKey: string,
    title: string,
    machineId: string,
    ratingKeys: string[],
    type: number
  ): Promise<PlexCollection> {
    const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(",")}`;
    const response = await this.client.post("/library/collections", null, {
      params: { type, title, smart: 0, sectionId: sectionKey, uri },
    });
    const metadata = response.data.MediaContainer.Metadata;
    return metadata[0];
  }

  async getCollectionItems(collectionRatingKey: string): Promise<PlexMetadataItem[]> {
    const response = await this.client.get(
      `/library/collections/${collectionRatingKey}/items`
    );
    return response.data.MediaContainer.Metadata || [];
  }

  async addCollectionItems(
    collectionRatingKey: string,
    machineId: string,
    ratingKeys: string[]
  ): Promise<void> {
    if (ratingKeys.length === 0) return;
    const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(",")}`;
    await this.client.put(
      `/library/collections/${collectionRatingKey}/items`,
      null,
      { params: { uri } }
    );
  }

  async removeCollectionItem(
    collectionRatingKey: string,
    ratingKey: string
  ): Promise<void> {
    await this.client.delete(
      `/library/collections/${collectionRatingKey}/children/${ratingKey}`
    );
  }

  async moveCollectionItem(
    collectionRatingKey: string,
    itemRatingKey: string,
    afterRatingKey?: string
  ): Promise<void> {
    const params: Record<string, string> = {};
    if (afterRatingKey) {
      params.after = afterRatingKey;
    }
    await this.client.put(
      `/library/collections/${collectionRatingKey}/items/${itemRatingKey}/move`,
      null,
      { params }
    );
  }

  async deleteCollection(collectionRatingKey: string): Promise<void> {
    await this.client.delete(
      `/library/collections/${collectionRatingKey}`
    );
  }

  async renameCollection(
    sectionKey: string,
    collectionRatingKey: string,
    newTitle: string
  ): Promise<void> {
    await this.client.put(
      `/library/sections/${sectionKey}/all`,
      null,
      {
        params: {
          type: 18,
          id: collectionRatingKey,
          "title.value": newTitle,
          "title.locked": 1,
        },
      }
    );
  }

  async editCollectionSortTitle(
    sectionKey: string,
    collectionRatingKey: string,
    sortTitle: string
  ): Promise<void> {
    await this.client.put(
      `/library/sections/${sectionKey}/all`,
      null,
      {
        params: {
          type: 18,
          id: collectionRatingKey,
          "titleSort.value": sortTitle,
          "titleSort.locked": 1,
        },
      }
    );
  }

  async editCollectionSort(
    collectionRatingKey: string,
    sort: number
  ): Promise<void> {
    await this.client.put(
      `/library/metadata/${collectionRatingKey}/prefs`,
      null,
      {
        params: { collectionSort: sort },
      }
    );
  }

  /**
   * Get the current visibility state for a collection's managed hub.
   */
  async getCollectionVisibility(
    sectionKey: string,
    collectionRatingKey: string
  ): Promise<{ identifier: string | null; home: boolean; shared: boolean; recommended: boolean }> {
    const response = await this.client.get(
      `/hubs/sections/${sectionKey}/manage`,
      { params: { metadataItemId: collectionRatingKey } }
    );

    const hubs: PlexManagedHub[] = response.data.MediaContainer.Hub || [];
    // Match by identifier format: custom.collection.{sectionKey}.{ratingKey}
    const expectedId = `custom.collection.${sectionKey}.${collectionRatingKey}`;
    const hub = hubs.find((h) => h.identifier === expectedId)
      ?? hubs.find((h) => h.identifier?.endsWith(`.${collectionRatingKey}`));

    if (!hub) {
      return { identifier: null, home: false, shared: false, recommended: false };
    }

    return {
      identifier: hub.identifier,
      home: !!hub.promotedToOwnHome,
      shared: !!hub.promotedToSharedHome,
      recommended: !!hub.promotedToRecommended,
    };
  }

  /**
   * Update a collection's visibility on home screens and library recommended.
   * Reads current state from Plex first, then applies the desired state.
   */
  async updateCollectionVisibility(
    sectionKey: string,
    collectionRatingKey: string,
    home: boolean,
    shared: boolean,
    recommended: boolean
  ): Promise<void> {
    const current = await this.getCollectionVisibility(sectionKey, collectionRatingKey);
    const wantAny = home || shared || recommended;

    const params = {
      promotedToOwnHome: home ? 1 : 0,
      promotedToSharedHome: shared ? 1 : 0,
      promotedToRecommended: recommended ? 1 : 0,
    };

    if (current.identifier) {
      if (!wantAny) {
        // All promotions disabled — delete the managed hub entirely
        try {
          await this.client.delete(
            `/hubs/sections/${sectionKey}/manage/${current.identifier}`
          );
        } catch {
          // Some Plex versions may not support DELETE on managed hubs;
          // fall back to setting all to 0
          await this.client.put(
            `/hubs/sections/${sectionKey}/manage/${current.identifier}`,
            null,
            { params }
          );
        }
      } else {
        // Update existing hub with desired visibility
        await this.client.put(
          `/hubs/sections/${sectionKey}/manage/${current.identifier}`,
          null,
          { params }
        );
      }
    } else if (wantAny) {
      // No hub exists yet — create one with the desired visibility
      await this.client.post(
        `/hubs/sections/${sectionKey}/manage`,
        null,
        { params: { ...params, metadataItemId: collectionRatingKey } }
      );
    }
    // If no hub exists and we don't want any promotion, nothing to do
  }

  // --- Session Management ---

  async getSessions(): Promise<PlexSession[]> {
    try {
      const response = await this.client.get("/status/sessions");
      const metadata = response.data.MediaContainer?.Metadata || [];

      return metadata.map((item: Record<string, unknown>) => {
        const user = (item.User as Record<string, unknown>) || {};
        const player = (item.Player as Record<string, unknown>) || {};
        const session = (item.Session as Record<string, unknown>) || {};
        const transcode = item.TranscodeSession as Record<string, unknown> | undefined;
        const media = (item.Media as Array<Record<string, unknown>>) || [];
        const firstMedia = media[0] || {};
        const parts = (firstMedia.Part as Array<Record<string, unknown>>) || [];
        const firstPart = parts[0] || {};
        const genreArray = (item.Genre as Array<{ tag: string }>) || [];

        return {
          sessionId: String(session.id ?? ""),
          userId: String(user.id ?? ""),
          username: String(user.title ?? "Unknown"),
          userThumb: String(user.thumb ?? ""),
          title: String(item.title ?? ""),
          parentTitle: item.parentTitle ? String(item.parentTitle) : undefined,
          grandparentTitle: item.grandparentTitle ? String(item.grandparentTitle) : undefined,
          type: String(item.type ?? ""),
          year: item.year as number | undefined,
          thumb: item.thumb ? String(item.thumb) : undefined,
          art: item.art ? String(item.art) : undefined,
          parentThumb: item.parentThumb ? String(item.parentThumb) : undefined,
          grandparentThumb: item.grandparentThumb ? String(item.grandparentThumb) : undefined,
          summary: item.summary ? String(item.summary) : undefined,
          // Content metadata
          contentRating: item.contentRating ? String(item.contentRating) : undefined,
          studio: item.studio ? String(item.studio) : undefined,
          rating: item.rating as number | undefined,
          audienceRating: item.audienceRating as number | undefined,
          tagline: item.tagline ? String(item.tagline) : undefined,
          genres: genreArray.length > 0 ? genreArray.map(g => g.tag) : undefined,
          // Media dimensions
          mediaWidth: firstMedia.width as number | undefined,
          mediaHeight: firstMedia.height as number | undefined,
          duration: item.duration as number | undefined,
          viewOffset: item.viewOffset as number | undefined,
          // Media details
          videoCodec: firstMedia.videoCodec ? String(firstMedia.videoCodec) : undefined,
          audioCodec: firstMedia.audioCodec ? String(firstMedia.audioCodec) : undefined,
          container: firstMedia.container ? String(firstMedia.container) : undefined,
          bitrate: firstMedia.bitrate as number | undefined,
          aspectRatio: firstMedia.aspectRatio ? String(firstMedia.aspectRatio) : undefined,
          audioChannels: firstMedia.audioChannels as number | undefined,
          videoResolution: firstMedia.videoResolution ? String(firstMedia.videoResolution) : undefined,
          videoProfile: firstMedia.videoProfile ? String(firstMedia.videoProfile) : undefined,
          audioProfile: firstMedia.audioProfile ? String(firstMedia.audioProfile) : undefined,
          optimizedForStreaming: firstMedia.optimizedForStreaming != null ? !!firstMedia.optimizedForStreaming : undefined,
          // File info
          partFile: firstPart.file ? String(firstPart.file) : undefined,
          partSize: firstPart.size as number | undefined,
          player: {
            product: String(player.product ?? ""),
            platform: String(player.platform ?? ""),
            state: String(player.state ?? ""),
            address: String(player.address ?? ""),
            local: !!player.local,
          },
          session: {
            bandwidth: (session.bandwidth as number) ?? 0,
            location: String(session.location ?? ""),
          },
          ...(transcode && {
            transcoding: {
              videoDecision: String(transcode.videoDecision ?? ""),
              audioDecision: String(transcode.audioDecision ?? ""),
              throttled: !!transcode.throttled,
              sourceVideoCodec: transcode.sourceVideoCodec ? String(transcode.sourceVideoCodec) : undefined,
              sourceAudioCodec: transcode.sourceAudioCodec ? String(transcode.sourceAudioCodec) : undefined,
              speed: transcode.speed as number | undefined,
              transcodeHwRequested: transcode.transcodeHwRequested != null ? !!transcode.transcodeHwRequested : undefined,
            },
          }),
        } satisfies PlexSession;
      });
    } catch (error) {
      logger.debug("Plex", "Failed to fetch sessions", { error: String(error) });
      return [];
    }
  }

  async terminateSession(sessionId: string, reason: string): Promise<void> {
    await this.client.post("/status/sessions/terminate", null, {
      params: { sessionId, reason },
    });
  }

  getImageUrl(path: string): string {
    return `${this.baseURL}${path}?X-Plex-Token=${this.token}`;
  }

  async fetchImage(path: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await this.client.get(path, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    return {
      data: Buffer.from(response.data),
      contentType: response.headers["content-type"] || "image/jpeg",
    };
  }

  // --- Preroll Management ---

  async getPrerollSetting(): Promise<string> {
    const response = await this.client.get("/:/prefs");
    const prefs = response.data?.MediaContainer?.Setting || [];
    const prerollPref = prefs.find((p: { id: string }) => p.id === "CinemaTrailersPrerollID");
    return prerollPref?.value ?? "";
  }

  async setPrerollPath(path: string): Promise<void> {
    await this.client.put("/:/prefs", null, {
      params: { CinemaTrailersPrerollID: path },
    });
  }

  async clearPreroll(): Promise<void> {
    await this.client.put("/:/prefs", null, {
      params: { CinemaTrailersPrerollID: "" },
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; serverName?: string }> {
    try {
      const response = await this.client.get("/");
      if (response.data.MediaContainer) {
        return { ok: true, serverName: response.data.MediaContainer.friendlyName };
      }
      // If no MediaContainer, this is probably not a Plex server
      return { ok: false, error: "This does not appear to be a Plex server — no MediaContainer in response" };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Check if this might be a Jellyfin/Emby server instead
        if (error.response?.status === 404 || error.response?.status === 302) {
          return { ok: false, error: "This does not appear to be a Plex server — check your server type selection" };
        }
        if (error.code === "ECONNREFUSED") {
          return { ok: false, error: "Connection refused - server may be offline or unreachable from this network" };
        }
        if (error.code === "ENOTFOUND") {
          return { ok: false, error: "DNS lookup failed - hostname could not be resolved" };
        }
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          return { ok: false, error: "Connection timed out - server may be unreachable" };
        }
        if (error.code === "ERR_TLS_CERT_ALTNAME_MISMATCH" || error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || error.message?.includes("certificate")) {
          return { ok: false, error: "TLS certificate verification failed - enable 'Skip TLS Verification' if using a self-signed certificate, or set NODE_EXTRA_CA_CERTS for a custom CA" };
        }
        if (error.response?.status === 401) {
          return { ok: false, error: "Authentication failed - invalid access token" };
        }
        return { ok: false, error: error.message };
      }
      return { ok: false, error: String(error) };
    }
  }

  // --- Watchlist ---

  async getWatchlistGuids(): Promise<Set<string>> {
    const guids = new Set<string>();
    try {
      const response = await axios.get(
        "https://metadata.provider.plex.tv/library/sections/watchlist/all",
        {
          headers: {
            "X-Plex-Token": this.token,
            Accept: "application/json",
          },
          params: {
            "X-Plex-Container-Start": 0,
            "X-Plex-Container-Size": 10000,
          },
          timeout: 30000,
        }
      );
      const items = response.data?.MediaContainer?.Metadata ?? [];
      for (const item of items) {
        const itemGuids = item.Guid ?? [];
        for (const guid of itemGuids) {
          if (guid.id) guids.add(guid.id);
        }
      }
    } catch (error) {
      logger.debug("Plex", "Failed to fetch watchlist", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return guids;
  }
}
