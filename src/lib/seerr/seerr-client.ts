import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry, NO_RETRY } from "@/lib/http-retry";

/**
 * Seerr's `MediaStatus` (server/constants/media.ts). Legacy Overseerr used 6
 * for DELETED; in Seerr 6 is BLOCKLISTED and DELETED moved to 7.
 */
export const SeerrMediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  BLOCKLISTED: 6,
  DELETED: 7,
} as const;

/**
 * Seerr's `MediaRequestStatus`. Seerr moves an APPROVED (or FAILED) request to
 * COMPLETED once its media becomes available, so nearly every request whose
 * media is actually in the library reports COMPLETED, not APPROVED.
 */
export const SeerrRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
} as const;

/**
 * Whether a request was approved at some point. FAILED is only reachable after
 * approval (the send to the Arr app failed), and COMPLETED is an approved
 * request whose media has since arrived.
 */
export function isApprovedSeerrRequest(status: number): boolean {
  return (
    status === SeerrRequestStatus.APPROVED ||
    status === SeerrRequestStatus.FAILED ||
    status === SeerrRequestStatus.COMPLETED
  );
}

export interface SeerrUser {
  id: number;
  email: string;
  username: string | null;
  plexUsername?: string | null;
  /** Set for users backed by a Jellyfin/Emby account (null otherwise). */
  jellyfinUsername?: string | null;
  avatar?: string;
  requestCount?: number;
}

/**
 * Identity of a Seerr requester: the name Seerr rules ("Requested By") are
 * evaluated against and the rule editor offers, the key the request-stats card
 * aggregates under, and the key the per-user drill-down resolves. All MUST use
 * this one function:
 * the drill-down used to accept a request whenever ANY of plexUsername /
 * username / email equalled the key, so a user whose display name equalled
 * another user's plexUsername had their requests (and watch state) folded
 * into that other user's dialog.
 */
export function seerrRequesterKey(
  r: Pick<SeerrUser, "plexUsername" | "username" | "email"> | null | undefined,
): string | null {
  return r?.plexUsername || r?.username || r?.email || null;
}

/**
 * The media-server account name a requester's plays are recorded under
 * (`WatchHistory.serverUsername`): the Plex username for a Plex-backed Seerr
 * user, the Jellyfin/Emby user name for one backed by those servers.
 */
export function seerrMediaUsername(
  r: Pick<SeerrUser, "plexUsername" | "jellyfinUsername"> | null | undefined,
): string | null {
  return r?.plexUsername || r?.jellyfinUsername || null;
}

export interface SeerrMediaInfo {
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  status: number; // SeerrMediaStatus
  /** Status of the 4K copy — the one a request with `is4k` refers to. */
  status4k?: number;
  requests?: SeerrRequest[];
  createdAt: string;
  updatedAt: string;
}

export interface SeerrRequest {
  id: number;
  type: "movie" | "tv";
  status: number; // SeerrRequestStatus
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
  mediaInfo?: SeerrMediaInfo;
}

export interface SeerrTvDetails {
  id: number;
  name: string;
  originalName: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  firstAirDate: string;
  mediaInfo?: SeerrMediaInfo;
}

/** Per-call options for the Seerr lookups interactive routes wait on. */
export interface SeerrCallOptions {
  /** `false` fails on the first transport error instead of retrying it. */
  retry?: boolean;
  /** Cancels the call once its caller has stopped waiting for the answer. */
  signal?: AbortSignal;
}

function callConfig(options: SeerrCallOptions): AxiosRequestConfig | undefined {
  if (options.retry !== false && !options.signal) return undefined;
  return {
    ...(options.retry === false ? NO_RETRY : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
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

    // Must be registered BEFORE the IntegrationError conversion below: axios
    // runs response interceptors in registration order, and the retry handler
    // needs the raw AxiosError (`config`/`response`). Registered after it, the
    // retry only ever saw an IntegrationError and rethrew every failure.
    configureRetry(this.client, "Seerr", logger);

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
          return Promise.reject(new IntegrationError("Seerr", error));
        }
        return Promise.reject(error);
      }
    );
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string }> {
    try {
      const { data } = await this.client.get<unknown>("/api/v1/settings/main", { ...NO_RETRY });
      // A forward-auth portal, an SPA fallback or another app can answer 2xx
      // (often after a followed redirect) with HTML or unrelated JSON. Only a
      // real Seerr settings object counts as connected — otherwise every later
      // call crashes on a missing `results` array.
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        typeof (data as { applicationTitle?: unknown }).applicationTitle !== "string"
      ) {
        return {
          ok: false,
          error:
            "The URL did not return Seerr settings — check the URL, and that any auth proxy lets /api through",
        };
      }
      return { ok: true, appName: "Seerr" };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getRequests(
    params?: {
      take?: number;
      skip?: number;
      filter?: string;
      sort?: string;
      sortDirection?: string;
      requestedBy?: number;
      mediaType?: string;
    },
    options: SeerrCallOptions = {},
  ): Promise<SeerrRequestsResponse> {
    const { data } = await this.client.get<SeerrRequestsResponse>(
      "/api/v1/request",
      { params, ...callConfig(options) }
    );
    return data;
  }

  async getRequest(id: number): Promise<SeerrRequest> {
    const { data } = await this.client.get<SeerrRequest>(
      `/api/v1/request/${id}`
    );
    return data;
  }

  async getMovie(tmdbId: number, options: SeerrCallOptions = {}): Promise<SeerrMovieDetails> {
    const config = callConfig(options);
    const { data } = config
      ? await this.client.get<SeerrMovieDetails>(`/api/v1/movie/${tmdbId}`, config)
      : await this.client.get<SeerrMovieDetails>(`/api/v1/movie/${tmdbId}`);
    return data;
  }

  async getTvShow(tmdbId: number, options: SeerrCallOptions = {}): Promise<SeerrTvDetails> {
    const config = callConfig(options);
    const { data } = config
      ? await this.client.get<SeerrTvDetails>(`/api/v1/tv/${tmdbId}`, config)
      : await this.client.get<SeerrTvDetails>(`/api/v1/tv/${tmdbId}`);
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
