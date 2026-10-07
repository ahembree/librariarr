import axios, { type AxiosInstance } from "axios";
import https from "https";
import { configureRetry } from "@/lib/http-retry";
import { ARTIST_MBID_SCHEME, firstMbid } from "@/lib/media/musicbrainz";
import {
  isUnreachable,
  markUnreachable,
  clearUnreachable,
  getLastFailureMessage,
  ServerUnreachableError,
} from "./health-cache";
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
  DetailedWatchHistoryEntry,
  DetailedWatchHistoryOptions,
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
import { isPrivateAddress } from "@/lib/media-server/local-address";
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

/**
 * How far a played-items listing may fall short of its reported
 * `TotalRecordCount` and still be read as an over-reported count rather than
 * a truncated answer: the larger of 50 items or 2% of the total. See
 * `forEachPlayedPage`.
 */
const PLAYED_SHORTFALL_TOLERANCE_ITEMS = 50;
const PLAYED_SHORTFALL_TOLERANCE_FRACTION = 0.02;

/**
 * One user's played-items listing answered without an error but cannot be
 * trusted to be complete: an empty first page under a non-zero
 * `TotalRecordCount`, or an empty page further short of it than an
 * over-reported count explains. Distinct from a transport failure because it
 * can be a lasting property of that ONE user's listing — a user whose played
 * items are all hidden from the key (parental limits, changed library access)
 * while the server still counts them — which no retry fixes.
 * `getDetailedWatchHistory` can therefore set that user aside when its caller
 * asks it to, instead of failing every sync of the server for good.
 *
 * Pages that ignore `StartIndex` are deliberately NOT this: that is the server
 * or a proxy in front of it, so it hits every user with more than one page,
 * and setting all of those aside handed the caller the history of only the
 * users with a single page. It fails the fetch like any other server fault.
 */
export class UnreliablePlayedListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreliablePlayedListingError";
  }
}

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
 * The path of a session endpoint, with the session id as exactly one segment.
 *
 * Session ids reach here from a request body (the terminate route, which a
 * `streams:write` API key can call), and the request goes out with the
 * server's admin token. Interpolated raw, an id of `../System/Shutdown?x=`
 * turned "stop this stream" into any admin POST on the server: the URL parser
 * resolves `..` before the request is sent and `?` pushes the rest of the path
 * into the query string. Encoding keeps `/`, `?`, `#` and `%` inside the
 * segment; `.` and `..` are refused because encoding leaves them dot segments.
 */
function sessionPath(sessionId: string, endpoint: "Message" | "Playing/Stop"): string {
  if (sessionId === "" || sessionId === "." || sessionId === "..") {
    throw new Error(`Invalid session id "${sessionId}"`);
  }
  return `/Sessions/${encodeURIComponent(sessionId)}/${endpoint}`;
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

    const baseURLForHealth = this.baseURL;
    // Auth headers added via interceptor — safe because requests only fire
    // after the subclass constructor has completed.
    this.client.interceptors.request.use((config) => {
      if (isUnreachable(baseURLForHealth)) {
        return Promise.reject(
          new ServerUnreachableError(baseURLForHealth, getLastFailureMessage(baseURLForHealth)),
        ) as never;
      }
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
        clearUnreachable(baseURLForHealth);
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

    configureRetry(this.client, () => this.logPrefix, logger, {
      onTerminalNetworkError: (error) => markUnreachable(baseURLForHealth, error),
    });
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

    // Fallback: list users and pick an administrator. Sort by Id first so the
    // selection is DETERMINISTIC across syncs (otherwise it depends on whatever
    // order the API returns, which can attribute watch history to a different
    // admin run-to-run). A non-admin fallback may have a restricted library
    // view, so warn — it can cause incomplete syncs / wrongful stale deletion.
    const usersRes = await this.client.get<
      Array<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }>
    >("/Users");
    const users = [...(usersRes.data || [])].sort((a, b) => a.Id.localeCompare(b.Id));
    const admin = users.find((u) => u.Policy?.IsAdministrator);
    const selected = admin ?? users[0];
    if (!selected) {
      throw new Error("No users found on server — cannot determine userId for API queries");
    }
    if (admin) {
      logger.debug(this.logPrefix, `Using admin user "${selected.Name}" for API queries (API key auth)`);
    } else {
      logger.warn(this.logPrefix, `No administrator user found; using "${selected.Name}" — library/watch-history queries may be incomplete (restricted view)`);
    }
    this.cachedUserId = selected.Id;
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
  ): Promise<{ items: MediaMetadataItem[]; total: number | null }> {
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
    // null when the server omits the count, so the caller falls back to the
    // short-page check instead of trusting a bogus total.
    const total =
      typeof response.data.TotalRecordCount === "number"
        ? response.data.TotalRecordCount
        : null;
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

  /**
   * `since` is ignored — a played-items listing has no per-play dates to
   * filter by (see `MediaServerClient.getDetailedWatchHistory`).
   */
  async getDetailedWatchHistory(
    options?: DetailedWatchHistoryOptions,
  ): Promise<DetailedWatchHistoryEntry[]> {
    const report = options?.report;
    const entries: DetailedWatchHistoryEntry[] = [];

    // Any failure here propagates: the caller commits this result with a
    // destructive full replace, so a hard failure (e.g. /Users unreachable)
    // must skip it rather than wipe stored history.
    const usersRes = await this.client.get<unknown>("/Users");
    // A 200 whose body is not a user list — an HTML page from a proxy, an
    // empty body — used to read as "no users, no plays", and the full replace
    // then deleted every stored play and marked the history established.
    if (!Array.isArray(usersRes.data)) {
      throw new Error(`${this.logPrefix} returned a malformed /Users response (not a list)`);
    }
    const users = usersRes.data as Array<{ Id: string; Name: string }>;
    let usersRead = 0;

    for (const user of users) {
      // Held back until this user's walk has finished: a walk that fails
      // partway must contribute nothing. A caller told the user is incomplete
      // keeps the user's stored rows, and the pages that did arrive would be
      // stored on top of them.
      const userEntries: DetailedWatchHistoryEntry[] = [];
      try {
        await this.forEachPlayedPage(user.Id, (items) => {
          for (const item of items) {
            const playCount = item.UserData?.PlayCount ?? 0;
            if (playCount <= 0) continue;

            for (let i = 0; i < playCount; i++) {
              userEntries.push({
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
        });
      } catch (error) {
        // Two failures are a property of this ONE user rather than of the
        // fetch: the key cannot read the user (401/403) or the user no longer
        // exists (404), or the listing answered in a shape that cannot be
        // trusted to be complete (`UnreliablePlayedListingError`). Either can
        // last indefinitely, so failing the whole scan for it blocks every
        // history sync of the server for good. A caller that passes a report
        // is told which users are incomplete, and why — it keeps their stored
        // rows, and treats the two differently when deciding whether it may
        // vouch for the history (`IncompleteUserReason`). Without one, a
        // refused user is skipped as before and an unreliable listing fails
        // the fetch — nothing would protect the user's stored rows from the
        // full replace.
        //
        // Anything else — a timeout, a 5xx, a dropped connection mid-page, a
        // malformed page, pages that ignore `StartIndex` — is a fault of the
        // fetch, not of this user, and must propagate: swallowing it handed
        // the caller a PARTIAL history that it then committed with a
        // destructive full replace, deleting every play this user's pages
        // never delivered.
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const refused = status === 401 || status === 403 || status === 404;
        if (report && (refused || error instanceof UnreliablePlayedListingError)) {
          report.incompleteUsers.set(user.Name, refused ? "refused" : "unreliable");
          logger.warn(
            this.logPrefix,
            `Could not read the complete watch history of user "${user.Name}" ` +
              `(${refused ? `HTTP ${status}` : (error as Error).message}); ` +
              `their stored plays are not replaced`,
          );
          continue;
        }
        if (refused) {
          logger.warn(
            this.logPrefix,
            `Skipping watch history for user "${user.Name}" (HTTP ${status})`,
          );
          continue;
        }
        throw error;
      }
      usersRead++;
      // A loop, not `push(...userEntries)`: one user's played set can run to
      // six figures, past the engine's argument-count limit for a spread call.
      for (const entry of userEntries) entries.push(entry);
    }

    // Setting a user aside is only safe while somebody's history was read.
    // When NO user could be read the result is not "nobody played anything"
    // but "nothing could be read" — a key that lost its rights, a proxy
    // answering 403 to every user route — and returning the empty list let the
    // full replace delete every stored play and mark the history established,
    // arming every play-activity rule on an empty relation.
    if (users.length > 0 && usersRead === 0) {
      throw new Error(
        `${this.logPrefix} could not read the played-items listing for all ${users.length} user(s)`,
      );
    }

    return entries;
  }

  /**
   * Page through one user's played items, handing each page to `onPage`.
   *
   * Ends on `TotalRecordCount` when the server reports it (on this page or,
   * when this one omits it, an earlier one), and on a short page only when it
   * never has — the previous loop stopped on ANY page shorter than
   * the size asked for, which trusts the server (or a proxy in front of it) to
   * honour `Limit`, and a capped page silently truncated the user's history to
   * its first page before the full replace committed it. The offset advances
   * by the items actually returned, for the same reason.
   *
   * Each item is handed on at most once per user. The listing is paged by
   * offset, so an item marked played (or unplayed) while the walk is in
   * progress shifts every later row by one and the next page repeats the item
   * the previous one ended on. Delivered twice, its `PlayCount` undated play
   * entries were stored twice — and `playCount` is monotonic, so the inflation
   * was permanent. The stable `SortBy` keeps the order itself from changing
   * between requests: `DateCreated` does not move when somebody plays the
   * item (unlike the server's default), and a newly added item sorts last.
   */
  private async forEachPlayedPage(
    userId: string,
    onPage: (
      items: Array<{
        Id: string;
        UserData?: { PlayCount?: number; LastPlayedDate?: string };
      }>,
    ) => void,
  ): Promise<void> {
    const PAGE_SIZE = 1000;
    // Runaway backstop only (10M played items per user): a server that ignored
    // `StartIndex` and reported no total would otherwise page forever.
    const MAX_PAGES = 10_000;
    let startIndex = 0;
    let firstPageLength: number | undefined;
    // The total an earlier page reported, for a page that omits it: a proxy
    // that strips it from one page must not turn the rest of the walk back
    // into "a short page is the end" (which truncated it) or let an empty page
    // end it without the shortfall check.
    let reportedTotal: number | null = null;
    const seen = new Set<string>();

    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(`${this.logPrefix} played-items listing did not end after ${MAX_PAGES} pages`);
      }
      const res = await this.client.get<unknown>(`/Users/${userId}/Items`, {
        params: {
          IsPlayed: true,
          Recursive: true,
          Fields: "UserData",
          // Only the types a library stores. Without the filter the scan
          // also walked every played Series, Season and BoxSet, which can
          // never map to a MediaItem and were dropped on arrival.
          IncludeItemTypes: "Movie,Episode,Audio",
          SortBy: "DateCreated,SortName",
          SortOrder: "Ascending",
          StartIndex: startIndex,
          Limit: PAGE_SIZE,
        },
      });

      const body = res.data as { Items?: unknown; TotalRecordCount?: unknown } | null;
      // A body with no `Items` list is not "this user played nothing" — that
      // answer is `{ Items: [], TotalRecordCount: 0 }`.
      if (!body || typeof body !== "object" || !Array.isArray(body.Items)) {
        throw new Error(`${this.logPrefix} returned a malformed played-items page (no Items list)`);
      }
      const items = body.Items as Array<{
        Id: string;
        UserData?: { PlayCount?: number; LastPlayedDate?: string };
      }>;
      if (typeof body.TotalRecordCount === "number") reportedTotal = body.TotalRecordCount;
      const total = reportedTotal;

      if (items.length === 0) {
        if (total != null && startIndex < total) {
          // An empty page short of the reported total is one of two things,
          // and the full replace downstream makes guessing wrong expensive in
          // both directions. Servers do over-report the count a little (it
          // comes from a separate query: items the user cannot see, an item
          // unmarked played mid-walk), and throwing on that failed every sync
          // of such a server forever. But a proxy answering `Items: []`
          // mid-list looks the same, and ending there committed a truncated
          // history and deleted every play past it. So only a SMALL shortfall
          // after this user's list actually delivered something is taken as
          // over-reporting; an empty first page or a large gap still throws,
          // and the stored history stays as it was (for this user, when the
          // caller takes a report — see `UnreliablePlayedListingError`).
          const shortfall = total - startIndex;
          const tolerated = Math.max(
            PLAYED_SHORTFALL_TOLERANCE_ITEMS,
            Math.ceil(total * PLAYED_SHORTFALL_TOLERANCE_FRACTION),
          );
          if (startIndex === 0 || shortfall > tolerated) {
            throw new UnreliablePlayedListingError(
              `${this.logPrefix} played-items listing ended at ${startIndex} of a reported ${total}`,
            );
          }
          logger.warn(
            this.logPrefix,
            `Played-items listing ended at ${startIndex} of a reported ${total}; ` +
              `treating the shortfall as an over-reported total`,
          );
        }
        return;
      }

      const fresh = items.filter((item) => {
        if (seen.has(item.Id)) return false;
        seen.add(item.Id);
        return true;
      });
      // A whole page of items already delivered means `StartIndex` is being
      // ignored (every request answered with the first page); continuing
      // would deliver it again and again. A mid-walk shift repeats only as
      // many items as changed meanwhile, so a SHORT all-repeat page is the
      // end of the list pushed down a place or two, and is passed over. A
      // plain error, not `UnreliablePlayedListingError`: an ignored offset is
      // the server's or a proxy's, so it fails the fetch rather than setting
      // aside every user with more than one page.
      firstPageLength ??= items.length;
      if (fresh.length === 0 && items.length >= firstPageLength) {
        throw new Error(`${this.logPrefix} ignored StartIndex while paging played items`);
      }

      if (fresh.length > 0) onPage(fresh);
      // Advance by what the server returned, repeats included: the offset
      // addresses its list, not ours.
      startIndex += items.length;

      if (total != null) {
        if (startIndex >= total) return;
      } else if (items.length < PAGE_SIZE) {
        return;
      }
    }
  }

  /**
   * The library an item belongs to, as the `ItemId` `getLibraries()` reports
   * for it, or null when no ancestor is a library.
   *
   * Jellyfin/Emby items do not name their library — `BaseItemDto` has no
   * section field, unlike Plex's `librarySectionID` — so the incremental sync
   * had no way to place an item it had never stored, and escalated EVERY new
   * item on these servers to a whole-server sync. `/Items/{id}/Ancestors`
   * walks the parent chain (season → series → library → root); the
   * `CollectionFolder` in it IS the library, and its id is the id
   * `/Library/VirtualFolders` reports as `ItemId`.
   */
  async resolveLibraryKey(ratingKey: string): Promise<string | null> {
    const userId = await this.getUserId();
    const response = await this.client.get<Array<{ Id?: string; Type?: string }>>(
      `/Items/${ratingKey}/Ancestors`,
      { params: { UserId: userId } },
    );
    const ancestors = Array.isArray(response.data) ? response.data : [];
    const library = ancestors.find((a) => a.Type === "CollectionFolder" && a.Id);
    return library?.Id ?? null;
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
      // Propagate rather than swallow to [] — see the note in PlexClient
      // .getSessions. Callers treat a throw as "server unreachable this tick"
      // and preserve their per-server state instead of resetting it.
      logger.debug(this.logPrefix, "Failed to fetch sessions", {
        error: String(error),
      });
      throw error;
    }
  }

  /** Push an on-screen message to a client; best-effort. */
  private async sendClientMessage(
    sessionId: string,
    header: string,
    text: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.client.post(sessionPath(sessionId, "Message"), {
      Header: header,
      Text: text,
      TimeoutMs: timeoutMs,
    });
  }

  /** Warn a playing client without stopping it (for warn_then_terminate). */
  async notifySession(sessionId: string, message: string): Promise<void> {
    // Longer timeout than the termination toast: the warning should stay up
    // through the grace period until the stream actually stops.
    await this.sendClientMessage(sessionId, "Notice", message, 60000);
  }

  /**
   * All usernames known to the server (Jellyfin/Emby `/Users`). Lets the
   * excluded-users picker offer offline users, not just whoever happens to be
   * streaming right now.
   */
  async listUsernames(): Promise<string[]> {
    const res = await this.client.get<Array<{ Name?: string }>>("/Users");
    return (res.data ?? [])
      .map((u) => u.Name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  async terminateSession(sessionId: string, reason?: string): Promise<void> {
    // Unlike Plex's terminate endpoint, stopping playback on Jellyfin/Emby
    // carries no reason — the stream just dies. Push the configured message to
    // the client first so the user sees why. Best-effort: a client that can't
    // display messages must not prevent the termination itself. TimeoutMs
    // outlives the stop so the message stays up after playback ends.
    if (reason) {
      try {
        await this.sendClientMessage(sessionId, "Playback stopped", reason, 15000);
      } catch (error) {
        logger.debug(this.logPrefix, "Could not send termination message", {
          error: String(error),
        });
      }
    }

    await this.client.post(sessionPath(sessionId, "Playing/Stop"));
  }

  getImageUrl(path: string): string {
    // path may be a full Jellyfin image path (e.g. "/Items/{id}/Images/Primary")
    // or just an item ID.
    if (path.startsWith("/")) {
      return `${this.baseURL}${path}${path.includes("?") ? "&" : "?"}api_key=${this.token}`;
    }
    return `${this.baseURL}/Items/${path}/Images/Primary?api_key=${this.token}`;
  }

  async fetchImage(
    path: string,
    options?: { width?: number },
  ): Promise<{ data: Buffer; contentType: string }> {
    // Use the internal axios client (fixed baseURL + auth headers) to avoid SSRF.
    // Only accept relative paths starting with "/".
    const base = path.startsWith("/") ? path : `/Items/${path}/Images/Primary`;
    // Jellyfin/Emby resize server-side when asked, so request the size we are
    // actually going to store rather than pulling the full-resolution original.
    // `maxWidth` only ever shrinks — a source narrower than the hint comes back
    // untouched, which is what the local `withoutEnlargement` resize expects.
    const width = options?.width;
    const relativePath =
      width && width > 0 ? `${base}${base.includes("?") ? "&" : "?"}maxWidth=${width}` : base;
    const response = await this.client.get(relativePath, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const contentType = response.headers["content-type"];
    return {
      data: Buffer.from(response.data),
      contentType: typeof contentType === "string" ? contentType : "image/jpeg",
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
      // Music: the track's own MusicBrainz id, and its (album) artist's — the
      // id Lidarr keys artists by (see src/lib/sync/artist-mbid.ts).
      const trackMbid = firstMbid(providers.get("musicbrainztrack") ?? providers.get("musicbrainzrecording"));
      if (trackMbid) guids.push({ id: `mbid://${trackMbid}` });
      const artistMbid = firstMbid(providers.get("musicbrainzalbumartist") ?? providers.get("musicbrainzartist"));
      if (artistMbid) guids.push({ id: `${ARTIST_MBID_SCHEME}://${artistMbid}` });
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
    // Source dimensions of the file being played (NOT TranscodingInfo's
    // Width/Height, which is the transcode *output*). The transcode manager's
    // "4K Transcoding" criterion reads these — without them every
    // Jellyfin/Emby session looks sub-4K and the criterion never fires.
    //
    // Read them off the item itself: SessionManager builds NowPlayingItem with
    // ItemFields.MediaSources and .MediaStreams explicitly removed, so the
    // per-stream dimensions are never present here however the item looks
    // elsewhere in the API. Width/Height survive that trim. The MediaSources
    // path stays as a fallback for servers that do include it.
    const sourceVideoStream = item.MediaSources?.[0]?.MediaStreams?.find(
      (stream) => stream.Type === "Video",
    );
    const mediaWidth = item.Width ?? sourceVideoStream?.Width;
    const mediaHeight = item.Height ?? sourceVideoStream?.Height;
    // Music (item Type "Audio") has no video track, so a non-direct video
    // decision from TranscodingInfo is meaningless for it.
    const hasVideoContent = item.Type !== "Audio";
    const isLocal = isPrivateAddress(s.RemoteEndPoint);

    return {
      sessionId: s.Id,
      ratingKey: item.Id,
      userId: s.UserId,
      username: s.UserName,
      userThumb: "",
      title: item.Name,
      // Album/AlbumArtist for music, as normalizeItem maps them — without the
      // fallback a played track carries no artist or album.
      parentTitle: item.SeasonName ?? item.Album,
      grandparentTitle: item.SeriesName ?? item.AlbumArtist,
      type: mapItemType(item.Type),
      year: item.ProductionYear,
      ...(item.Type === "Episode" && {
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
      }),
      thumb: item.ImageTags?.Primary
        ? `/Items/${item.Id}/Images/Primary`
        : undefined,
      grandparentThumb:
        item.SeriesId && item.SeriesPrimaryImageTag
          ? `/Items/${item.SeriesId}/Images/Primary`
          : undefined,
      duration: ticksToMs(item.RunTimeTicks),
      viewOffset: ticksToMs(playState?.PositionTicks),
      mediaWidth,
      mediaHeight,
      player: {
        product: s.Client,
        platform: s.DeviceName,
        state: playState?.IsPaused ? "paused" : "playing",
        address: s.RemoteEndPoint ?? "",
        // Jellyfin/Emby have no `local` flag, so infer it from the client's
        // address. RemoteEndPoint is populated for LAN clients too, so its
        // mere presence says nothing — testing for truthiness marked every
        // session as WAN and made "Remote Transcoding" match all of them.
        local: isLocal,
      },
      session: {
        bandwidth: 0,
        location: isLocal ? "lan" : "wan",
      },
      ...(transcoding && {
        transcoding: {
          // IsVideoDirect = IsCopyCodec(OutputVideoCodec), and for an
          // audio-only job (music) OutputVideoCodec is null → IsVideoDirect is
          // false. Mapping that straight to "transcode" reported every music
          // transcode as a VIDEO transcode, so "Video Transcoding" terminated
          // audio-only streams. There is no video to transcode when the item
          // carries none, so force "copy" for audio items.
          videoDecision:
            !hasVideoContent || transcoding.IsVideoDirect ? "copy" : "transcode",
          audioDecision: transcoding.IsAudioDirect ? "copy" : "transcode",
          throttled: false,
          // Jellyfin/Emby report no transcode SPEED (CompletionPercentage is a
          // progress %, not a rate), so leave it unset rather than fabricating
          // "1.0x" — a made-up value the UI would show as if measured and that
          // would defeat the below-realtime warning. HardwareAccelerationType
          // is likewise omitted: it is the server's CONFIGURED accel, reported
          // even when a job silently falls back to software, so it cannot prove
          // a given stream is hardware-accelerated (see hardware-transcode.ts).
        },
      }),
    } satisfies MediaSession;
  }
}
