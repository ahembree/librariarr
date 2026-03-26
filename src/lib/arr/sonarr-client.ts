import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";

export interface SonarrSeries {
  id: number;
  title: string;
  titleSlug?: string;
  tvdbId: number;
  imdbId?: string;
  qualityProfileId: number;
  monitored: boolean;
  path: string;
  tags: number[];
  ratings?: {
    imdb?: { value: number };
    tmdb?: { value: number };
    rottenTomatoes?: { value: number };
  };
  statistics?: {
    seasonCount: number;
    episodeCount: number;
    episodeFileCount: number;
    sizeOnDisk: number;
  };
  added?: string;
  firstAired?: string;
  status?: string;
  ended?: boolean;
  seriesType?: string;
  originalLanguage?: { id: number; name: string };
  nextAiring?: string;
  seasons?: Array<{
    seasonNumber: number;
    monitored: boolean;
    statistics?: { episodeCount: number; episodeFileCount: number };
  }>;
}

export interface SonarrTag {
  id: number;
  label: string;
}

export interface SonarrQualityProfile {
  id: number;
  name: string;
}

export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  relativePath: string;
  size: number;
}

export interface SonarrExclusion {
  id?: number;
  tvdbId: number;
  title: string;
}

export class SonarrClient {
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
          logger.debug("Sonarr", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`, {
            message: error.message,
          });
        }
        return Promise.reject(error);
      }
    );
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string; version?: string }> {
    try {
      const response = await this.client.get("/api/v3/system/status");
      const { appName, version } = response.data;
      if (appName && appName !== "Sonarr") {
        return { ok: false, error: `Expected Sonarr but connected to ${appName}`, appName, version };
      }
      return { ok: true, appName, version };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getSeries(): Promise<SonarrSeries[]> {
    const { data } = await this.client.get<SonarrSeries[]>("/api/v3/series");
    return data;
  }

  async getSeriesById(id: number): Promise<SonarrSeries> {
    const { data } = await this.client.get<SonarrSeries>(
      `/api/v3/series/${id}`
    );
    return data;
  }

  async getSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
    const { data } = await this.client.get<SonarrSeries[]>("/api/v3/series", {
      params: { tvdbId },
    });
    return data.length > 0 ? data[0] : null;
  }

  async deleteSeries(
    id: number,
    deleteFiles: boolean = true,
    addImportListExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v3/series/${id}`, {
      params: { deleteFiles, addImportListExclusion },
    });
  }

  async updateSeries(id: number, series: Partial<SonarrSeries>): Promise<SonarrSeries> {
    const current = await this.getSeriesById(id);
    const { data } = await this.client.put<SonarrSeries>(
      `/api/v3/series/${id}`,
      { ...current, ...series }
    );
    return data;
  }

  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    const { data } = await this.client.get<SonarrEpisodeFile[]>("/api/v3/episodefile", {
      params: { seriesId },
    });
    return data;
  }

  async getEpisodes(seriesId: number): Promise<Array<{
    id: number;
    seasonNumber: number;
    episodeNumber: number;
    episodeFileId: number;
    hasFile: boolean;
  }>> {
    const { data } = await this.client.get("/api/v3/episode", {
      params: { seriesId },
    });
    return data;
  }

  async deleteEpisodeFiles(episodeFileIds: number[]): Promise<void> {
    if (episodeFileIds.length === 0) return;
    await this.client.delete("/api/v3/episodefile/bulk", {
      data: { episodeFileIds },
    });
  }

  async getQualityProfiles(): Promise<SonarrQualityProfile[]> {
    const { data } = await this.client.get<SonarrQualityProfile[]>(
      "/api/v3/qualityprofile"
    );
    return data;
  }

  async triggerSeriesSearch(seriesId: number): Promise<void> {
    await this.client.post("/api/v3/command", {
      name: "SeriesSearch",
      seriesId,
    });
  }

  async getQueue(seriesId: number): Promise<{ downloading: boolean; status: string | null }> {
    try {
      const { data } = await this.client.get("/api/v3/queue", {
        params: { seriesIds: [seriesId], pageSize: 10 },
      });
      const records = data.records || [];
      if (records.length === 0) return { downloading: false, status: null };
      const record = records[0];
      return { downloading: true, status: record.status ?? record.trackedDownloadStatus ?? "downloading" };
    } catch {
      return { downloading: false, status: null };
    }
  }

  async getTags(): Promise<SonarrTag[]> {
    const { data } = await this.client.get<SonarrTag[]>("/api/v3/tag");
    return data;
  }

  async createTag(label: string): Promise<SonarrTag> {
    const { data } = await this.client.post<SonarrTag>("/api/v3/tag", { label });
    return data;
  }

  async deleteTag(id: number): Promise<void> {
    await this.client.delete(`/api/v3/tag/${id}`);
  }

  async addExclusion(tvdbId: number, title: string): Promise<void> {
    await this.client.post("/api/v3/importlistexclusion", {
      tvdbId,
      title,
    });
  }

  async getLanguages(): Promise<{ id: number; name: string }[]> {
    const { data } = await this.client.get<{ id: number; name: string }[]>(
      "/api/v3/language"
    );
    return data;
  }

}
