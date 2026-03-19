import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";

export interface RadarrMovie {
  id: number;
  title: string;
  tmdbId: number;
  imdbId?: string;
  qualityProfileId: number;
  monitored: boolean;
  path: string;
  hasFile: boolean;
  movieFileId: number;
  sizeOnDisk: number;
  tags: number[];
  ratings?: {
    imdb?: { value: number };
    tmdb?: { value: number };
    rottenTomatoes?: { value: number };
  };
  added?: string;
  inCinemas?: string;
  physicalRelease?: string;
  digitalRelease?: string;
  runtime?: number;
  originalLanguage?: { id: number; name: string };
  movieFile?: { quality?: { quality?: { name?: string } }; dateAdded?: string };
  qualityCutoffNotMet?: boolean;
}

export interface RadarrTag {
  id: number;
  label: string;
}

export interface RadarrQualityProfile {
  id: number;
  name: string;
}

export interface RadarrMovieFile {
  id: number;
  movieId: number;
  relativePath: string;
  size: number;
}

export interface RadarrExclusion {
  id?: number;
  tmdbId: number;
  movieTitle: string;
  movieYear: number;
}

export class RadarrClient {
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
      logger.debug("Radarr", `${config.method?.toUpperCase()} ${config.url}`);
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        const start = (response.config as unknown as Record<string, unknown>).__startTime as number;
        const duration = start ? Date.now() - start : 0;
        logger.debug("Radarr", `${response.status} ${response.config.url} (${duration}ms)`);
        return response;
      },
      (error) => {
        if (axios.isAxiosError(error)) {
          logger.debug("Radarr", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}`, {
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
      if (appName && appName !== "Radarr") {
        return { ok: false, error: `Expected Radarr but connected to ${appName}`, appName, version };
      }
      return { ok: true, appName, version };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getMovies(): Promise<RadarrMovie[]> {
    const { data } = await this.client.get<RadarrMovie[]>("/api/v3/movie");
    return data;
  }

  async getMovieById(id: number): Promise<RadarrMovie> {
    const { data } = await this.client.get<RadarrMovie>(
      `/api/v3/movie/${id}`
    );
    return data;
  }

  async getMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
    const { data } = await this.client.get<RadarrMovie[]>("/api/v3/movie", {
      params: { tmdbId },
    });
    return data.length > 0 ? data[0] : null;
  }

  async deleteMovie(
    id: number,
    deleteFiles: boolean = true,
    addImportExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v3/movie/${id}`, {
      params: { deleteFiles, addImportExclusion },
    });
  }

  async updateMovie(id: number, movie: Partial<RadarrMovie>): Promise<RadarrMovie> {
    const current = await this.getMovieById(id);
    const { data } = await this.client.put<RadarrMovie>(
      `/api/v3/movie/${id}`,
      { ...current, ...movie }
    );
    return data;
  }

  async getMovieFiles(movieId: number): Promise<RadarrMovieFile[]> {
    const { data } = await this.client.get<RadarrMovieFile[]>("/api/v3/moviefile", {
      params: { movieId: [movieId] },
      paramsSerializer: { indexes: null },
    });
    return data;
  }

  async deleteMovieFile(movieFileId: number): Promise<void> {
    await this.client.delete(`/api/v3/moviefile/${movieFileId}`);
  }

  async getQualityProfiles(): Promise<RadarrQualityProfile[]> {
    const { data } = await this.client.get<RadarrQualityProfile[]>(
      "/api/v3/qualityprofile"
    );
    return data;
  }

  async triggerMovieSearch(movieId: number): Promise<void> {
    await this.client.post("/api/v3/command", {
      name: "MoviesSearch",
      movieIds: [movieId],
    });
  }

  async getQueue(movieId: number): Promise<{ downloading: boolean; status: string | null }> {
    try {
      const { data } = await this.client.get("/api/v3/queue", {
        params: { movieIds: [movieId], pageSize: 10 },
      });
      const records = data.records || [];
      if (records.length === 0) return { downloading: false, status: null };
      const record = records[0];
      return { downloading: true, status: record.status ?? record.trackedDownloadStatus ?? "downloading" };
    } catch {
      return { downloading: false, status: null };
    }
  }

  async getTags(): Promise<RadarrTag[]> {
    const { data } = await this.client.get<RadarrTag[]>("/api/v3/tag");
    return data;
  }

  async createTag(label: string): Promise<RadarrTag> {
    const { data } = await this.client.post<RadarrTag>("/api/v3/tag", { label });
    return data;
  }

  async deleteTag(id: number): Promise<void> {
    await this.client.delete(`/api/v3/tag/${id}`);
  }

  async addExclusion(
    tmdbId: number,
    movieTitle: string,
    movieYear: number
  ): Promise<void> {
    await this.client.post("/api/v3/exclusions", {
      tmdbId,
      movieTitle,
      movieYear,
    });
  }

  async getLanguages(): Promise<{ id: number; name: string }[]> {
    const { data } = await this.client.get<{ id: number; name: string }[]>(
      "/api/v3/language"
    );
    return data;
  }

}
