import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry, NO_RETRY } from "@/lib/http-retry";

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  qualityProfileId: number;
  metadataProfileId: number;
  monitored: boolean;
  path: string;
  tags: number[];
  ratings?: {
    value: number;
    votes: number;
  };
  statistics?: {
    albumCount: number;
    trackCount: number;
    trackFileCount: number;
    sizeOnDisk: number;
  };
  added?: string;
  // Lidarr artist status: continuing | ended | deleted
  status?: string;
}

interface LidarrTag {
  id: number;
  label: string;
}

interface LidarrQualityProfile {
  id: number;
  name: string;
}

interface LidarrAlbum {
  id: number;
  title: string;
}

export interface LidarrTrack {
  id: number;
  albumId: number;
  trackFileId: number;
  title: string;
  hasFile: boolean;
  trackNumber?: string;
  absoluteTrackNumber?: number;
  /** Disc number within the release. */
  mediumNumber?: number;
  /** MusicBrainz release-track id. */
  foreignTrackId?: string;
  /** MusicBrainz recording id. */
  foreignRecordingId?: string;
}

interface LidarrMediaManagementConfig {
  recycleBin: string | null;
  recycleBinCleanupDays: number;
}

export class LidarrClient {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      baseURL: baseURL.replace(/\/+$/, ""),
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    this.client.interceptors.request.use((config) => {
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      return config;
    });

    // Must be registered BEFORE the IntegrationError conversion below: axios
    // runs response interceptors in registration order, and the retry handler
    // needs the raw AxiosError (`config`/`response`). Registered after it, the
    // retry only ever saw an IntegrationError and rethrew every failure.
    configureRetry(this.client, "Lidarr", logger);

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error)) {
          const start = (error.config as unknown as Record<string, unknown>)?.__startTime as number | undefined;
          const duration = start ? ` (${Date.now() - start}ms)` : "";
          logger.debug("Lidarr", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`, {
            message: error.message,
          });
          return Promise.reject(new IntegrationError("Lidarr", error));
        }
        return Promise.reject(error);
      }
    );
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string; version?: string }> {
    try {
      const response = await this.client.get("/api/v1/system/status", { ...NO_RETRY });
      const { appName, version } = response.data;
      if (appName && appName !== "Lidarr") {
        return { ok: false, error: `Expected Lidarr but connected to ${appName}`, appName, version };
      }
      return { ok: true, appName, version };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getArtists(): Promise<LidarrArtist[]> {
    const { data } = await this.client.get<LidarrArtist[]>("/api/v1/artist");
    return data;
  }

  async getArtistById(id: number): Promise<LidarrArtist> {
    const { data } = await this.client.get<LidarrArtist>(
      `/api/v1/artist/${id}`
    );
    return data;
  }

  async getArtistByMusicBrainzId(mbId: string): Promise<LidarrArtist | null> {
    // Server-side lookup by MusicBrainz id (mirrors Radarr's ?tmdbId= and
    // Sonarr's ?tvdbId=). Avoids fetching the entire artist library per call.
    const { data } = await this.client.get<LidarrArtist[]>("/api/v1/artist", {
      params: { mbId },
    });
    // Lidarr filters by foreignArtistId — and, for an artist MusicBrainz has
    // merged, by its old ids too, answering with the artist under its NEW id.
    // So a single answer is the artist even when its id differs. Several
    // answers mean the filter was ignored (an older version returning the
    // whole library): only an exact id is trusted then, never `data[0]`.
    const exact = data.find((a) => a.foreignArtistId === mbId);
    if (exact) return exact;
    return data.length === 1 ? data[0] : null;
  }

  async deleteArtist(
    id: number,
    deleteFiles: boolean = true,
    addImportListExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v1/artist/${id}`, {
      params: { deleteFiles, addImportListExclusion },
    });
  }

  async updateArtist(id: number, artist: Partial<LidarrArtist>): Promise<LidarrArtist> {
    const current = await this.getArtistById(id);
    const { data } = await this.client.put<LidarrArtist>(
      `/api/v1/artist/${id}`,
      { ...current, ...artist }
    );
    return data;
  }

  async deleteTrackFiles(trackFileIds: number[]): Promise<void> {
    if (trackFileIds.length === 0) return;
    await this.client.delete("/api/v1/trackfile/bulk", {
      data: { trackFileIds },
    });
  }

  async getAlbums(artistId: number): Promise<LidarrAlbum[]> {
    const { data } = await this.client.get<LidarrAlbum[]>("/api/v1/album", {
      params: { artistId },
    });
    return data;
  }

  async getTracks(artistId: number): Promise<LidarrTrack[]> {
    const { data } = await this.client.get<LidarrTrack[]>("/api/v1/track", {
      params: { artistId },
    });
    return data;
  }

  async getQualityProfiles(): Promise<LidarrQualityProfile[]> {
    const { data } = await this.client.get<LidarrQualityProfile[]>(
      "/api/v1/qualityprofile"
    );
    return data;
  }

  async triggerArtistSearch(artistId: number): Promise<void> {
    await this.client.post("/api/v1/command", {
      name: "ArtistSearch",
      artistId,
    });
  }

  async getTags(): Promise<LidarrTag[]> {
    const { data } = await this.client.get<LidarrTag[]>("/api/v1/tag");
    return data;
  }

  async createTag(label: string): Promise<LidarrTag> {
    const { data } = await this.client.post<LidarrTag>("/api/v1/tag", { label });
    return data;
  }

  async deleteTag(id: number): Promise<void> {
    await this.client.delete(`/api/v1/tag/${id}`);
  }

  /**
   * Only caller is the rule editor's recycle-bin check, which the Save button
   * waits on — a probe, so it reports the first failure (NO_RETRY) instead of
   * holding Save through four timeouts.
   */
  async getMediaManagementConfig(): Promise<LidarrMediaManagementConfig> {
    const { data } = await this.client.get<LidarrMediaManagementConfig>(
      "/api/v1/config/mediamanagement",
      { ...NO_RETRY },
    );
    return data;
  }
}
