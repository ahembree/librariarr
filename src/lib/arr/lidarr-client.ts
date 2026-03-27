import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";

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
}

export interface LidarrTag {
  id: number;
  label: string;
}

export interface LidarrQualityProfile {
  id: number;
  name: string;
}

export interface LidarrTrackFile {
  id: number;
  artistId: number;
  relativePath: string;
  size: number;
}

export interface LidarrExclusion {
  id?: number;
  foreignId: string;
  artistName: string;
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

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error)) {
          const start = (error.config as unknown as Record<string, unknown>)?.__startTime as number | undefined;
          const duration = start ? ` (${Date.now() - start}ms)` : "";
          logger.debug("Lidarr", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`, {
            message: error.message,
          });
        }
        return Promise.reject(error);
      }
    );
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string; version?: string }> {
    try {
      const response = await this.client.get("/api/v1/system/status");
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
    const artists = await this.getArtists();
    return artists.find((a) => a.foreignArtistId === mbId) ?? null;
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

  async getTrackFiles(artistId: number): Promise<LidarrTrackFile[]> {
    const { data } = await this.client.get<LidarrTrackFile[]>("/api/v1/trackfile", {
      params: { artistId },
    });
    return data;
  }

  async deleteTrackFiles(trackFileIds: number[]): Promise<void> {
    if (trackFileIds.length === 0) return;
    await this.client.delete("/api/v1/trackfile/bulk", {
      data: { trackFileIds },
    });
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

  async getQueue(artistId: number): Promise<{ downloading: boolean; status: string | null }> {
    try {
      const { data } = await this.client.get("/api/v1/queue", {
        params: { artistIds: [artistId], pageSize: 10 },
      });
      const records = data.records || [];
      if (records.length === 0) return { downloading: false, status: null };
      const record = records[0];
      return { downloading: true, status: record.status ?? record.trackedDownloadStatus ?? "downloading" };
    } catch {
      return { downloading: false, status: null };
    }
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

  async addExclusion(foreignId: string, artistName: string): Promise<void> {
    await this.client.post("/api/v1/importlistexclusion", {
      foreignId,
      artistName,
    });
  }
}
