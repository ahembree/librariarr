import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";

export interface SeerrUser {
  id: number;
  email: string;
  username: string;
  plexUsername?: string;
  avatar?: string;
  requestCount?: number;
}

export interface SeerrMediaInfo {
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  status: number; // 1=UNKNOWN,2=PENDING,3=PROCESSING,4=PARTIAL,5=AVAILABLE,6=DELETED
  requests?: SeerrRequest[];
  createdAt: string;
  updatedAt: string;
}

export interface SeerrRequest {
  id: number;
  type: "movie" | "tv";
  status: number; // 1=PENDING,2=APPROVED,3=DECLINED
  media: SeerrMediaInfo;
  createdAt: string;
  updatedAt: string;
  requestedBy: SeerrUser;
  modifiedBy: SeerrUser | null;
  is4k: boolean;
  serverId: number;
  profileId: number;
  rootFolder: string;
}

export interface SeerrPageInfo {
  page: number;
  pages: number;
  results: number;
}

export interface SeerrRequestsResponse {
  pageInfo: SeerrPageInfo;
  results: SeerrRequest[];
}

export interface SeerrUsersResponse {
  pageInfo: SeerrPageInfo;
  results: SeerrUser[];
}

export interface SeerrMovieDetails {
  id: number;
  title: string;
  originalTitle: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  releaseDate: string;
}

export interface SeerrTvDetails {
  id: number;
  name: string;
  originalName: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  firstAirDate: string;
}

export class SeerrClient {
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
          logger.debug(
            "Seerr",
            `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`,
            { message: error.message }
          );
        }
        return Promise.reject(error);
      }
    );
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string }> {
    try {
      await this.client.get("/api/v1/settings/main");
      return { ok: true, appName: "Seerr" };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getRequests(params?: {
    take?: number;
    skip?: number;
    filter?: string;
    sort?: string;
    sortDirection?: string;
    requestedBy?: number;
    mediaType?: string;
  }): Promise<SeerrRequestsResponse> {
    const { data } = await this.client.get<SeerrRequestsResponse>(
      "/api/v1/request",
      { params }
    );
    return data;
  }

  async getRequest(id: number): Promise<SeerrRequest> {
    const { data } = await this.client.get<SeerrRequest>(
      `/api/v1/request/${id}`
    );
    return data;
  }

  async getMovie(tmdbId: number): Promise<SeerrMovieDetails> {
    const { data } = await this.client.get<SeerrMovieDetails>(
      `/api/v1/movie/${tmdbId}`
    );
    return data;
  }

  async getTvShow(tmdbId: number): Promise<SeerrTvDetails> {
    const { data } = await this.client.get<SeerrTvDetails>(
      `/api/v1/tv/${tmdbId}`
    );
    return data;
  }

  async getUsers(params?: {
    take?: number;
    skip?: number;
  }): Promise<SeerrUsersResponse> {
    const { data } = await this.client.get<SeerrUsersResponse>(
      "/api/v1/user",
      { params }
    );
    return data;
  }
}
