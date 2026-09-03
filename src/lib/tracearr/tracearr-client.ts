import axios, { AxiosInstance, isAxiosError } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry } from "@/lib/http-retry";

/**
 * Client for Tracearr's read-only public REST API.
 *
 * Axios, no SDK — matching `seerr-client.ts`. Two API versions are live and we
 * use both deliberately:
 *
 *  - `/api/v1/public/health` for connectivity **and** the media-server list.
 *    v2 has no health route, and `HealthResponse.servers[]` is the only place
 *    the `server_id` UUIDs the mapping UI needs are enumerated.
 *  - `/api/v2/public/history` for play events. v1's `SessionHistory` carries no
 *    media identifier at all (only title strings), so it cannot be joined to a
 *    `MediaItem`; v2's `HistoryRecord` carries `rating_key` plus the provider
 *    ids and is keyset-paginated with `since`/`until`, which is what makes an
 *    incremental import possible.
 *
 * Verified against the published OpenAPI spec
 * (`https://github.com/connorgallopo/tracearr/releases/latest/download/openapi-v2.json`,
 * `Tracearr Public API` 2.0.0) — every nullability below mirrors that document.
 */

/** Tracearr's own timeout budget. History pages of 100 aggregate rows are cheap. */
const REQUEST_TIMEOUT_MS = 20_000;

/** `pageSize` caps at 100 server-side (default 25); ask for the max. */
export const MAX_PAGE_SIZE = 100;

/**
 * The API is rate limited per key on a rolling 1-minute window. A 429 is
 * therefore always transient — wait and the window rolls. We retry **once**,
 * bounded, so a paging loop degrades instead of hammering: `configureRetry`
 * deliberately does not cover 429 (it handles network/5xx only).
 */
const RATE_LIMIT_MAX_RETRIES = 1;
const RATE_LIMIT_FALLBACK_DELAY_MS = 5_000;
/** Never honour an absurd `Retry-After`; a paging loop must stay bounded. */
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

export type TracearrServerType = "plex" | "jellyfin" | "emby";
export type TracearrMediaType =
  | "movie"
  | "episode"
  | "track"
  | "live"
  | "photo"
  | "trailer"
  | "unknown";
export type TracearrPlaybackState = "playing" | "paused" | "stopped";
export type TracearrStreamDecision = "directplay" | "copy" | "transcode";

/** `HealthResponse.servers[]` — the media servers this instance monitors. */
export interface TracearrServerStatus {
  id: string;
  name: string;
  type: TracearrServerType;
  online: boolean;
  activeStreams: number;
}

export interface TracearrHealthResponse {
  status: "ok";
  version: string;
  timestamp: string;
  servers: TracearrServerStatus[];
}

export interface TracearrHistoryUser {
  /** Tracearr identity id (stable across a user's per-server accounts). */
  id: string;
  server_user_id: string;
  username: string | null;
  thumb_url: string | null;
  avatar_url: string | null;
}

export interface TracearrTranscodeInfo {
  containerDecision?: TracearrStreamDecision;
  sourceContainer?: string;
  streamContainer?: string;
  hwRequested?: boolean;
  hwDecoding?: string;
  hwEncoding?: string;
  speed?: number;
  throttled?: boolean;
  reasons?: string[];
}

export interface TracearrSubtitleInfo {
  decision?: string;
  codec?: string;
  language?: string;
  forced?: boolean;
}

export interface TracearrSourceVideoDetails {
  bitrate?: number;
  framerate?: string;
  dynamicRange?: string;
  aspectRatio?: number;
  profile?: string;
  level?: string;
  colorSpace?: string;
  colorDepth?: number;
}

export interface TracearrSourceAudioDetails {
  bitrate?: number;
  channelLayout?: string;
  language?: string;
  sampleRate?: number;
}

export interface TracearrStreamVideoDetails {
  bitrate?: number;
  width?: number;
  height?: number;
  framerate?: string;
  dynamicRange?: string;
}

export interface TracearrStreamAudioDetails {
  bitrate?: number;
  channels?: number;
  language?: string;
}

/**
 * One play, aggregated over its **resume chain**.
 *
 * This is the single most important thing to understand about the shape: `id`
 * is the chain id ("the id of the first session in the play") and
 * `reference_id` is documented as the chain key shared by every segment —
 * which in the current spec *equals* `id`. `segment_count` is therefore the
 * only field that reveals a resumed play.
 *
 * Because a record aggregates a chain, it is **not immutable**: resuming a play
 * folds a new segment into the same `id`, moving `state`, `stopped_at`,
 * `progress_ms`, `duration_ms`, `percent_complete`, `segment_count` and
 * `watched`. Anything importing these rows must update on conflict, not ignore
 * — see `sync-tracearr-history.ts`.
 */
export interface TracearrHistoryRecord {
  id: string;
  server_id: string;
  server_name: string;
  server_type: TracearrServerType;
  state: TracearrPlaybackState;
  media_type: TracearrMediaType;
  media_title: string;
  show_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  year: number | null;
  artist_name: string | null;
  album_name: string | null;
  track_number: number | null;
  disc_number: number | null;
  thumb_path: string | null;
  poster_url: string | null;
  /** Watch time summed over the play's in-window segments. Required, non-null. */
  duration_ms: number;
  progress_ms: number | null;
  /** The item's full runtime. Nullable — the denominator may be unknown. */
  total_duration_ms: number | null;
  /** 0-100 with 1 decimal. The headline completion figure, and nullable. */
  percent_complete: number | null;
  started_at: string;
  stopped_at: string | null;
  /** True once the play crossed the per-media-type completion threshold. */
  watched: boolean;
  /** Number of sessions in the resume chain. */
  segment_count: number;
  device: string | null;
  player: string | null;
  product: string | null;
  platform: string | null;
  is_transcode: boolean;
  video_decision: TracearrStreamDecision | null;
  audio_decision: TracearrStreamDecision | null;
  /** kbps. */
  bitrate: number | null;
  source_video_codec: string | null;
  source_audio_codec: string | null;
  source_audio_channels: number | null;
  source_video_width: number | null;
  source_video_height: number | null;
  source_video_details: TracearrSourceVideoDetails | null;
  source_audio_details: TracearrSourceAudioDetails | null;
  stream_video_codec: string | null;
  stream_audio_codec: string | null;
  stream_video_details: TracearrStreamVideoDetails | null;
  stream_audio_details: TracearrStreamAudioDetails | null;
  transcode_info: TracearrTranscodeInfo | null;
  subtitle_info: TracearrSubtitleInfo | null;
  resolution: string | null;
  source_video_codec_display: string | null;
  source_audio_codec_display: string | null;
  audio_channels_display: string | null;
  stream_video_codec_display: string | null;
  stream_audio_codec_display: string | null;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  /** Server-specific media id; null when the server never provided one. */
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  library_id: string | null;
  genres: string[] | null;
  reference_id: string;
  user: TracearrHistoryUser;
}

export interface TracearrHistoryPage {
  records: TracearrHistoryRecord[];
  /** Opaque keyset cursor; null when there are no further pages. */
  nextCursor: string | null;
}

export interface GetHistoryPageOptions {
  cursor?: string;
  /** Plays whose session starts at or after this instant. */
  since?: Date;
  /** Plays whose session starts at or before this instant. */
  until?: Date;
  pageSize?: number;
}

interface RawHistoryResponse {
  data: TracearrHistoryRecord[];
  meta: { nextCursor: string | null; pageSize: number };
}

export class TracearrClient {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      // Strip only trailing slashes — an instance may sit under a base path
      // (`https://host/tracearr`), and axios joins that with the relative
      // request paths below, so the prefix must survive.
      baseURL: baseURL.replace(/\/+$/, ""),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    this.client.interceptors.request.use((config) => {
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (isAxiosError(error)) {
          const start = (error.config as unknown as Record<string, unknown>)
            ?.__startTime as number | undefined;
          const duration = start ? ` (${Date.now() - start}ms)` : "";
          logger.debug(
            "Tracearr",
            `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`,
            { message: error.message },
          );
          return Promise.reject(new IntegrationError("Tracearr", error));
        }
        return Promise.reject(error);
      },
    );

    configureRetry(this.client, "Tracearr", logger);
  }

  /**
   * Connectivity probe. `GET /api/v1/public/health` is the only unauthenticated-
   * shaped, side-effect-free route that also validates the bearer key (it 401s
   * on a bad one), so a 200 means "reachable AND the key works".
   */
  async testConnection(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
    serverCount?: number;
  }> {
    try {
      const health = await this.getHealth();
      return {
        ok: true,
        version: health.version,
        serverCount: health.servers.length,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getHealth(): Promise<TracearrHealthResponse> {
    const { data } = await this.client.get<TracearrHealthResponse>(
      "/api/v1/public/health",
    );
    return data;
  }

  /**
   * The media servers this Tracearr instance monitors, for the per-server
   * mapping dropdown. One instance aggregates many servers, which is exactly
   * why every history pull must be scoped by `server_id`.
   */
  async listServers(): Promise<TracearrServerStatus[]> {
    const health = await this.getHealth();
    return Array.isArray(health.servers) ? health.servers : [];
  }

  /**
   * One keyset page of `/api/v2/public/history`, always scoped to a single
   * Tracearr `server_id`.
   *
   * `since` is inclusive ("at or after this instant") and — per the spec —
   * also scopes the aggregation: `duration_ms`, `segment_count` and
   * `percent_complete` cover only in-window segments. That is why the importer
   * pulls from a watermark *minus* an overlap rather than from the watermark
   * itself: a chain whose first segment predates the window would otherwise be
   * reported with a truncated completion figure.
   */
  async getHistoryPage(
    serverId: string,
    options: GetHistoryPageOptions = {},
  ): Promise<TracearrHistoryPage> {
    const { cursor, since, until, pageSize = MAX_PAGE_SIZE } = options;

    const params: Record<string, string | number> = {
      server_id: serverId,
      pageSize: Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE)),
    };
    if (cursor) params.cursor = cursor;
    if (since) params.since = since.toISOString();
    if (until) params.until = until.toISOString();

    const data = await this.getWithRateLimitRetry<RawHistoryResponse>(
      "/api/v2/public/history",
      params,
    );

    return {
      records: Array.isArray(data?.data) ? data.data : [],
      nextCursor: data?.meta?.nextCursor ?? null,
    };
  }

  /**
   * GET with a single bounded retry on 429. The limit is per key on a 1-minute
   * window, so honour `Retry-After` when present and otherwise wait a fixed
   * beat. Every other failure — and a second 429 — throws, which is what the
   * importer wants: the append/upsert model means a thrown error leaves already
   * imported rows intact and the next run resumes from the watermark.
   */
  private async getWithRateLimitRetry<T>(
    url: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await this.client.get<T>(url, { params });
        return data;
      } catch (error: unknown) {
        const status =
          error instanceof IntegrationError
            ? error.status
            : isAxiosError(error)
              ? (error.response?.status ?? null)
              : null;

        if (status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) throw error;

        const delay = this.resolveRetryDelay(error);
        logger.warn(
          "Tracearr",
          `Rate limited (429) on ${url} — retrying once in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * `Retry-After` is either delta-seconds or an HTTP date. Clamp both into
   * `(0, RATE_LIMIT_MAX_DELAY_MS]` so a hostile or clock-skewed header can't
   * stall a sync for hours.
   */
  private resolveRetryDelay(error: unknown): number {
    const cause = error instanceof IntegrationError ? error.cause : error;
    const header = isAxiosError(cause)
      ? cause.response?.headers?.["retry-after"]
      : undefined;

    if (header != null) {
      const raw = String(header).trim();
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, RATE_LIMIT_MAX_DELAY_MS);
      }
      const at = Date.parse(raw);
      if (!Number.isNaN(at)) {
        const wait = at - Date.now();
        if (wait > 0) return Math.min(wait, RATE_LIMIT_MAX_DELAY_MS);
      }
    }

    return RATE_LIMIT_FALLBACK_DELAY_MS;
  }
}
