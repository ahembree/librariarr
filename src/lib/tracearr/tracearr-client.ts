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

/**
 * Retry budget for a **bulk history walk**, where the single interactive retry
 * above is not enough.
 *
 * The limiter is per key on a rolling 1-minute window, so a first import of a
 * large history — 160k plays is ~1,600 sequential pages at the API's 100-record
 * maximum — will hit it repeatedly and by design. One retry would abandon the
 * import on the first throttle, and although the append/upsert model makes that
 * safe and resumable, the user would have to re-run Refresh many times to get
 * through a first import. Waiting out the window instead is the whole point of
 * a rolling limit.
 */
const BULK_RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_FALLBACK_DELAY_MS = 5_000;
/** Never honour an absurd `Retry-After`; a paging loop must stay bounded. */
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/**
 * How far back `findOldestPlayAt` will look. Plex predates this, but no media
 * server's play history does, and an unbounded lower bound would just add
 * probes that always come back empty.
 */
const OLDEST_PLAY_SEARCH_FLOOR = new Date("2008-01-01T00:00:00.000Z");

/**
 * Page cap for one `getHistoryForItem` walk.
 *
 * Named for the walk rather than for the rating key because the two questions
 * are not the same size. A rating-key query really is one item's own plays, and
 * 2,000 of those is already unreachable — a daily-rewatched episode over five
 * years is ~1,800. But the provider-id fallback asks by `tvdb_id`, and the ids
 * stored on an episode are SERIES-level, so that query deliberately returns
 * every play of every episode of the show: a 700-episode show in a household of
 * six that rewatches is comfortably five figures of plays. The old 20-page
 * bound was sized for the single-item case and silently truncated the
 * series-wide one, dropping the OLDEST plays (the walk is newest-first) —
 * exactly the ones the archive exists to recover.
 *
 * 200 pages is 20,000 plays at the API's 100-record maximum. It stays a
 * backstop against a cursor that never terminates, not a throttle; the cursor
 * loop below also guards a repeating keyset, and the caller bounds how many
 * items it asks about.
 */
const ITEM_HISTORY_MAX_PAGES = 200;

/** Bisection stops at one hour — finer resolution buys a progress bar nothing. */
const OLDEST_PLAY_SEARCH_PRECISION_MS = 60 * 60 * 1000;

/** Users are few relative to plays; this is a runaway guard, not a real bound. */
const USER_PAGE_CAP = 50;

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
  /**
   * Use the bulk retry budget rather than the single interactive retry. Set by
   * the importer's paging loop; leave off for one-off calls.
   */
  bulk?: boolean;
  /** Aborts an in-flight page and any pending rate-limit backoff. */
  signal?: AbortSignal;
  /** Plays whose session starts at or after this instant. */
  since?: Date;
  /** Plays whose session starts at or before this instant. */
  until?: Date;
  pageSize?: number;
}

/** One per-server account behind a Tracearr identity. */
export interface TracearrUserAccount {
  server_id: string;
  server_type: TracearrServerType;
  server_user_id: string;
  /** The media server's own user identifier. */
  external_user_id: string;
  /** Account name on that server — the vocabulary the native path uses. */
  username: string;
  removed_at: string | null;
}

export interface TracearrUserIdentity {
  id: string;
  /** Tracearr's friendly cross-server label. NOT the media server's name. */
  username: string;
  email: string | null;
  plex_account_id: string | null;
  accounts: TracearrUserAccount[];
}

interface RawUsersResponse {
  data: TracearrUserIdentity[];
  meta: { nextCursor: string | null; pageSize: number };
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
    let health: TracearrHealthResponse;
    try {
      health = await this.getHealth();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }

    // Health alone is not a sufficient test. It lives on v1, which every
    // Tracearr serves, but the history import is v2-only — v1's history carries
    // no media identifier and cannot be joined to a library item. A pre-2.0.0
    // instance therefore passes a health check and then imports precisely
    // nothing, silently, forever. Since mapping a media server to an instance
    // clears that server's stored watch history, "connection OK" has to mean
    // "the endpoint this integration actually depends on works".
    //
    // One record is enough to prove the route exists and the key is accepted.
    // A server_id is required by our own paging helper but not by the API, so
    // probe unscoped — this is a capability check, not a data fetch.
    try {
      await this.getWithRateLimitRetry("/api/v2/public/history", {
        pageSize: 1,
      });
    } catch (error: unknown) {
      const status = error instanceof IntegrationError ? error.status : null;
      if (status === 404 || status === 400) {
        return {
          ok: false,
          error:
            `Reached Tracearr ${health.version}, but its v2 public API is not available ` +
            `(HTTP ${status}). Librariarr needs Tracearr 2.0.0 or later — v1 history ` +
            `carries no media identifier, so plays cannot be matched to library items.`,
        };
      }
      const msg = error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }

    return {
      ok: true,
      version: health.version,
      serverCount: health.servers.length,
    };
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
    const { cursor, since, until, pageSize = MAX_PAGE_SIZE, bulk, signal } = options;

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
      {
        maxRetries: bulk
          ? BULK_RATE_LIMIT_MAX_RETRIES
          : RATE_LIMIT_MAX_RETRIES,
        signal,
      },
    );

    return {
      records: Array.isArray(data?.data) ? data.data : [],
      nextCursor: data?.meta?.nextCursor ?? null,
    };
  }

  /**
   * Every play this server holds for ONE item, addressed by the media server's
   * own `rating_key`.
   *
   * This exists for the re-added-item recovery pass
   * (`sync/tracearr-backfill-additions.ts`): deleting a `MediaItem` cascade-
   * deletes its `WatchHistory`, so an item that comes back looks never watched
   * — which is precisely the state destructive "not played in N months" and
   * "playCount = 0" lifecycle rules are written against. Tracearr still holds
   * those plays; this is how they are asked for.
   *
   * **`rating_key` takes a single value, not a list** (checked against the
   * published spec), so there is no batched form of this question: recovering N
   * items costs N requests against an API that rate-limits per key on a rolling
   * 1-minute window. Every caller must therefore bound how many items it asks
   * about — see `RECENT_ADDITION_WINDOW_MS` and the candidate cap there.
   *
   * Uses the bulk 429 budget for the same reason the archive walk does: a
   * sequence of requests will be throttled by design, and waiting the rolling
   * window out is what the limit is for.
   */
  async getHistoryForRatingKey(
    serverId: string,
    ratingKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TracearrHistoryRecord[]> {
    return this.getHistoryForItem(serverId, { ratingKey }, options);
  }

  /**
   * Every play Tracearr holds for one item, found by whichever identity we have.
   *
   * The rating key is the precise handle, but it is the one that does not
   * survive a re-add: Plex mints a NEW rating key when an item is removed and
   * added back, so the plays Tracearr recorded under the old key are
   * unreachable by key — which is exactly the case this lookup exists to serve.
   * The API also filters on `tvdb_id`, `tmdb_id` and `imdb_id`, so a provider id
   * recovers what the rating key cannot. Verified against a live instance: the
   * tmdb and tvdb queries returned the same records as the rating-key query.
   *
   * Precedence mirrors `computeSeriesKey` — TVDB, then TMDB, then IMDB — so the
   * identity used here is the same one the rest of the app trusts.
   *
   * For an episode the stored ids are SERIES-level, so a TVDB lookup returns the
   * whole show's plays rather than one episode's. That is a feature, not a
   * problem: the caller resolves every returned record through the shared join
   * index, which constrains episodes by season and number, so one request
   * recovers a whole series instead of one per episode.
   */
  async getHistoryForItem(
    serverId: string,
    filter: {
      ratingKey?: string;
      tvdbId?: string | number | null;
      tmdbId?: string | number | null;
      imdbId?: string | null;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<TracearrHistoryRecord[]> {
    const { signal } = options;

    const identity: Record<string, string | number> = {};
    if (filter.ratingKey) identity.rating_key = filter.ratingKey;
    else if (filter.tvdbId != null && `${filter.tvdbId}`.trim() !== "") {
      identity.tvdb_id = `${filter.tvdbId}`.trim();
    } else if (filter.tmdbId != null && `${filter.tmdbId}`.trim() !== "") {
      identity.tmdb_id = `${filter.tmdbId}`.trim();
    } else if (filter.imdbId && filter.imdbId.trim() !== "") {
      identity.imdb_id = filter.imdbId.trim();
    } else {
      // Nothing to ask by. Returning empty beats issuing an unfiltered request,
      // which would page the server's ENTIRE history for one item.
      return [];
    }

    const records: TracearrHistoryRecord[] = [];
    // A stuck keyset would otherwise page forever over the same records — the
    // same guard the archive walk carries, for the same reason.
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    // Set only when the cap cut a walk that still had pages left, so the log
    // below reports a real truncation and never a walk that simply ended.
    let truncated = false;

    for (let page = 0; ; page++) {
      if (signal?.aborted) break;
      if (page >= ITEM_HISTORY_MAX_PAGES) {
        truncated = true;
        break;
      }

      const params: Record<string, string | number> = {
        server_id: serverId,
        ...identity,
        pageSize: MAX_PAGE_SIZE,
      };
      if (cursor) params.cursor = cursor;

      const data = await this.getWithRateLimitRetry<RawHistoryResponse>(
        "/api/v2/public/history",
        params,
        { maxRetries: BULK_RATE_LIMIT_MAX_RETRIES, signal },
      );

      if (Array.isArray(data?.data)) records.push(...data.data);

      const next = data?.meta?.nextCursor ?? null;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }

    // A truncated walk and "that show had no more plays" are the same silence
    // otherwise, and nothing ever asks again: the recovery pass only looks at
    // recently-added items, and this query keeps no resume state the way the
    // archive walk does. So say it out loud, with the identity that was asked
    // by, or the missing plays are undiagnosable from the outside.
    if (truncated) {
      const asked = Object.entries(identity)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      logger.warn(
        "Tracearr",
        `History walk for ${asked} hit the ${ITEM_HISTORY_MAX_PAGES}-page cap ` +
          `after ${records.length} plays — older plays were not recovered`,
        { serverId, ...identity },
      );
    }

    return records;
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
    options: { maxRetries?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await this.client.get<T>(url, {
          params,
          signal: options.signal,
        });
        return data;
      } catch (error: unknown) {
        const status =
          error instanceof IntegrationError
            ? error.status
            : isAxiosError(error)
              ? (error.response?.status ?? null)
              : null;

        if (status !== 429 || attempt >= maxRetries) throw error;
        // An aborted request is the user cancelling; never sit in a backoff
        // sleep after that.
        if (options.signal?.aborted) throw error;

        const delay = this.resolveRetryDelay(error);
        logger.warn(
          "Tracearr",
          `Rate limited (429) on ${url} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await this.sleep(delay, options.signal);
        // `sleep` resolves EARLY on abort, so without re-checking here the loop
        // would fall straight through and issue the retry we just cancelled.
        if (options.signal?.aborted) throw error;
      }
    }
  }

  /**
   * The `started_at` of the OLDEST play this server holds, or null if it has
   * none.
   *
   * Found by bisecting the `until` filter rather than paging: the API is keyset
   * -paginated newest-first with no total and no count endpoint, so the only
   * way to learn where the history *starts* is to ask whether anything exists
   * before a given instant and halve the range. ~16 calls at hour precision for
   * a seven-year history, against ~1,600 to walk it.
   *
   * This is what lets the backfill report determinate progress. A record-count
   * denominator is not obtainable, and would not be truthful even if it were —
   * plays whose media has since left the library cannot be stored (the row's
   * media FK is required), so "rows imported / records available" would stall
   * short of 100% by design. How far back the walk has reached does complete.
   *
   * Hour precision is deliberate: it halves the call count versus second
   * precision and no progress bar can express the difference.
   */
  async findOldestPlayAt(
    serverId: string,
    options: { signal?: AbortSignal; floor?: Date } = {},
  ): Promise<Date | null> {
    const { signal, floor } = options;

    const newestPage = await this.getHistoryPage(serverId, {
      pageSize: 1,
      signal,
    });
    const newest = newestPage.records[0]?.started_at;
    if (!newest) return null;

    let lo = (floor ?? OLDEST_PLAY_SEARCH_FLOOR).getTime();
    let hi = Date.parse(newest);
    if (!Number.isFinite(hi)) return null;
    // A history that starts before the floor: report the floor probe's answer
    // rather than searching outside the range.
    if (hi <= lo) return new Date(hi);

    // The newest record at-or-before the current upper bound. Each successful
    // probe lowers it, so when the range collapses this holds the true oldest.
    let oldest = new Date(hi);

    while (hi - lo > OLDEST_PLAY_SEARCH_PRECISION_MS) {
      if (signal?.aborted) break;
      const mid = lo + Math.floor((hi - lo) / 2);
      const page = await this.getHistoryPage(serverId, {
        pageSize: 1,
        until: new Date(mid),
        signal,
      });
      const found = page.records[0]?.started_at;
      if (found) {
        oldest = new Date(found);
        hi = mid;
      } else {
        lo = mid;
      }
    }

    return oldest;
  }

  /**
   * `server_user_id` → the account name that server itself uses, for one
   * Tracearr server.
   *
   * This exists because a history record's `user.username` is Tracearr's
   * **identity** name — its friendly, cross-server label — and NOT the account
   * name on the media server. On a real Plex server they disagree for most
   * users: the same person is "Nick W" in a history record and "weingart" in
   * Plex's own `/accounts`, which is what Librariarr's native watch-history
   * path stores. Storing the identity name would make the same human two
   * different people depending on which source a server happens to use —
   * breaking `watchedByUser` rules on a source switch and splitting leaderboards
   * on a mixed setup.
   *
   * `UserAccount.username` is documented as "Account name on that server", and
   * on a live instance it matched Plex's `/accounts` name for every account
   * checked. Keying on `server_user_id` — which every history record carries —
   * bridges the two vocabularies without a media-server round-trip, and works
   * the same for Jellyfin and Emby.
   *
   * `include_removed=true` is not optional here. Per the published spec the
   * parameter defaults to **false**, which drops every identity whose accounts
   * have all been removed from their server — and departed users are what an
   * archive is disproportionately made of: someone who left two years ago still
   * owns two years of plays. Leaving the default would leave exactly their
   * `server_user_id`s unmapped, so their rows would fall back to Tracearr's
   * identity name — the vocabulary split this bridge exists to prevent, landing
   * hardest on the oldest rows. A removed account's name is still the name the
   * native path stored for them, so it is the right answer, not a stale one.
   */
  async getServerAccountNames(
    serverId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, string>> {
    const { signal } = options;
    const names = new Map<string, string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < USER_PAGE_CAP; page++) {
      if (signal?.aborted) break;

      // Sent as a string because the schema accepts `boolean | string` and our
      // param bag is string|number — axios serialises either identically.
      const params: Record<string, string | number> = {
        pageSize: MAX_PAGE_SIZE,
        include_removed: "true",
      };
      if (cursor) params.cursor = cursor;

      const data = await this.getWithRateLimitRetry<RawUsersResponse>(
        "/api/v2/public/users",
        params,
        { maxRetries: BULK_RATE_LIMIT_MAX_RETRIES, signal },
      );

      for (const identity of data?.data ?? []) {
        for (const account of identity?.accounts ?? []) {
          // One Tracearr instance aggregates many servers; an account on a
          // different one would map a stranger's id onto this server.
          if (account?.server_id !== serverId) continue;
          if (account.server_user_id && account.username) {
            names.set(account.server_user_id, account.username);
          }
        }
      }

      const next = data?.meta?.nextCursor ?? null;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }

    return names;
  }

  /** Sleep that resolves early when `signal` aborts, so a cancel is immediate. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
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
