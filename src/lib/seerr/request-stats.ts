import { prisma } from "@/lib/db";
import {
  SeerrClient,
  seerrMediaUsername,
  seerrRequesterKey,
  type SeerrRequest,
} from "@/lib/seerr/seerr-client";
import { walkSeerrRequests } from "@/lib/seerr/request-walk";
import {
  countShowEpisodes,
  loadLocalShows,
  type SeerrShowRef,
} from "@/lib/seerr/library-match";
import { appCache } from "@/lib/cache/memory-cache";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { logger } from "@/lib/logger";

const STATS_TTL_MS = 60_000;

export interface SeerrUserRequestStats {
  /** Stable identity key — see `seerrRequesterKey`. */
  userKey: string;
  seerrUsername: string;
  plexUsername: string | null;
  avatar: string | null;
  requestCount: number;
  movieCount: number;
  /** TV REQUESTS — Seerr creates one per later batch of seasons, so not shows. */
  seriesCount: number;
  /** Distinct shows those TV requests are for (the unit `seriesWithAnyEpisodeWatched` counts in). */
  distinctSeriesCount: number;
  /** Movie REQUESTS whose movie the user watched (same unit as `movieCount`). */
  moviesWatched: number;
  seriesWithAnyEpisodeWatched: number;
  episodesWatched: number;
  episodesAvailable: number;
  /** False when the user has no media-server account name (no watch correlation possible). */
  correlatable: boolean;
}

export interface SeerrRequestStatsResult {
  configured: boolean;
  /**
   * True when at least one instance's request list could not be read in full
   * (unreachable, a page failed, the listing shifted mid-walk). The counts then
   * cover only what was read, and the result is not cached.
   */
  partial: boolean;
  users: SeerrUserRequestStats[];
  totals: {
    requestCount: number;
    movieCount: number;
    seriesCount: number;
    moviesWatched: number;
    episodesWatched: number;
    episodesAvailable: number;
  };
}

interface UserAccumulator {
  seerrUsername: string;
  plexUsername: string | null;
  /** Account name watch history is matched on — see `seerrMediaUsername`. */
  mediaUsername: string | null;
  avatar: string | null;
  total: number;
  movies: number;
  series: number;
  /** tmdbId → number of movie requests for it (HD + 4K, several instances). */
  movieRequestsByTmdb: Map<number, number>;
  seriesRefs: SeerrShowRef[];
}

export async function getSeerrRequestStats(
  userId: string
): Promise<SeerrRequestStatsResult> {
  const cacheKey = `seerr-request-stats:${userId}`;
  const result = await appCache.getOrSet(cacheKey, () => computeSeerrRequestStats(userId), STATS_TTL_MS);
  // Never serve a truncated walk from cache — the next load retries it.
  if (result.partial) appCache.invalidate(cacheKey);
  return result;
}

/**
 * Drop every cached Seerr-derived answer for this user. Called by the Seerr
 * instance create/update/delete routes, so removing or disabling an instance
 * doesn't leave the dashboard card, the drill-down and the integration health
 * banner reporting it for another minute.
 */
export function invalidateSeerrCaches(userId: string): void {
  appCache.invalidate(`seerr-request-stats:${userId}`);
  appCache.invalidatePrefix(`seerr-user-requests:${userId}:`);
  appCache.invalidate(`integrations:health:${userId}`);
}

async function computeSeerrRequestStats(
  userId: string
): Promise<SeerrRequestStatsResult> {
  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  if (instances.length === 0) {
    return {
      configured: false,
      partial: false,
      users: [],
      totals: {
        requestCount: 0,
        movieCount: 0,
        seriesCount: 0,
        moviesWatched: 0,
        episodesWatched: 0,
        episodesAvailable: 0,
      },
    };
  }

  const accumulators = new Map<string, UserAccumulator>();
  let partial = false;

  // Every instance is walked at once — one that is down must not hold back
  // the others — and fails fast: this is the dashboard, and a failed walk is
  // never cached, so a dead instance's retry budget would be paid on every
  // load. Results are then folded in instance order, so which requester's
  // name and avatar a row shows does not depend on which walk finished first.
  const walks = await Promise.all(
    instances.map(async (instance) => {
      const client = new SeerrClient(instance.url, instance.apiKey);
      // Buffer per instance: a walk that fails partway contributes nothing
      // rather than an arbitrary prefix of its requests.
      const requests: SeerrRequest[] = [];
      try {
        await walkSeerrRequests(
          client,
          { instanceName: instance.name, failFast: true },
          (req) => requests.push(req),
        );
        return requests;
      } catch (error) {
        logger.warn(
          "Seerr",
          `Failed to fetch requests from ${instance.name} for stats`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        return null;
      }
    }),
  );

  for (const requests of walks) {
    if (!requests) {
      partial = true;
      continue;
    }
    for (const req of requests) {
      const requester = req.requestedBy;
      const key = seerrRequesterKey(requester);
      if (!requester || !key) continue;
      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          seerrUsername:
            requester.username || requester.plexUsername || requester.jellyfinUsername || requester.email,
          plexUsername: requester.plexUsername ?? null,
          mediaUsername: seerrMediaUsername(requester),
          avatar: requester.avatar ?? null,
          total: 0,
          movies: 0,
          series: 0,
          movieRequestsByTmdb: new Map(),
          seriesRefs: [],
        };
        accumulators.set(key, acc);
      }
      // A requester keyed by its plexUsername shares it with every requester
      // folded into this key, so adopting a later one is unambiguous — and
      // makes correlation independent of which instance/request came first.
      if (acc.plexUsername == null && requester.plexUsername) acc.plexUsername = requester.plexUsername;
      if (acc.mediaUsername == null) acc.mediaUsername = seerrMediaUsername(requester);
      if (acc.avatar == null && requester.avatar) acc.avatar = requester.avatar;
      acc.total++;
      if (req.type === "movie") {
        acc.movies++;
        const tmdb = req.media?.tmdbId;
        if (tmdb) acc.movieRequestsByTmdb.set(tmdb, (acc.movieRequestsByTmdb.get(tmdb) ?? 0) + 1);
      } else if (req.type === "tv") {
        acc.series++;
        if (req.media?.tvdbId || req.media?.tmdbId) {
          acc.seriesRefs.push({ tvdbId: req.media.tvdbId, tmdbId: req.media.tmdbId });
        }
      }
    }
  }

  const watchMaps = await buildWatchMaps(userId, accumulators);

  const users: SeerrUserRequestStats[] = [];
  for (const [userKey, acc] of accumulators.entries()) {
    const correlatable = acc.mediaUsername != null;
    let moviesWatched = 0;
    let seriesWithAnyEpisodeWatched = 0;
    let episodesWatched = 0;
    let episodesAvailable = 0;

    if (correlatable) {
      // Counted per REQUEST, like the denominator (`movieCount`) and like the
      // drill-down: counting distinct watched movies over every request made
      // an HD + 4K request for one watched film read 50%.
      const movieKeys = watchMaps.watchedMoviesByUser.get(acc.mediaUsername!) ?? new Set<number>();
      for (const [tmdb, n] of acc.movieRequestsByTmdb) {
        if (movieKeys.has(tmdb)) moviesWatched += n;
      }

      // Each show counts once however many requests (season batches, HD/4K,
      // several instances) point at it.
      const seriesWatch = watchMaps.watchedEpisodesByUser.get(acc.mediaUsername!);
      const seen = new Set<string>();
      for (const ref of acc.seriesRefs) {
        const show = watchMaps.shows.resolve(ref);
        if (!show || seen.has(show.seriesKey)) continue;
        seen.add(show.seriesKey);
        episodesAvailable += countShowEpisodes(show);
        const watchedSet = seriesWatch?.get(show.seriesKey);
        if (watchedSet && watchedSet.size > 0) {
          seriesWithAnyEpisodeWatched++;
          episodesWatched += watchedSet.size;
        }
      }
    }

    users.push({
      userKey,
      seerrUsername: acc.seerrUsername,
      plexUsername: acc.plexUsername,
      avatar: acc.avatar,
      requestCount: acc.total,
      movieCount: acc.movies,
      seriesCount: acc.series,
      distinctSeriesCount: new Set(
        acc.seriesRefs.map((r) => (r.tmdbId ? `tmdb:${r.tmdbId}` : `tvdb:${r.tvdbId}`)),
      ).size,
      moviesWatched,
      seriesWithAnyEpisodeWatched,
      episodesWatched,
      episodesAvailable,
      correlatable,
    });
  }

  users.sort((a, b) => b.requestCount - a.requestCount || a.seerrUsername.localeCompare(b.seerrUsername));

  const totals = users.reduce(
    (acc, u) => {
      acc.requestCount += u.requestCount;
      acc.movieCount += u.movieCount;
      acc.seriesCount += u.seriesCount;
      acc.moviesWatched += u.moviesWatched;
      acc.episodesWatched += u.episodesWatched;
      acc.episodesAvailable += u.episodesAvailable;
      return acc;
    },
    {
      requestCount: 0,
      movieCount: 0,
      seriesCount: 0,
      moviesWatched: 0,
      episodesWatched: 0,
      episodesAvailable: 0,
    }
  );

  return { configured: true, partial, users, totals };
}

interface WatchMaps {
  /** media username → set of TMDB IDs the user has watched. */
  watchedMoviesByUser: Map<string, Set<number>>;
  /** media username → (show seriesKey → set of canonical episode dedupKeys watched). */
  watchedEpisodesByUser: Map<string, Map<string, Set<string>>>;
  /** The requested shows present in the library. */
  shows: Awaited<ReturnType<typeof loadLocalShows>>;
}

async function buildWatchMaps(
  userId: string,
  accumulators: Map<string, UserAccumulator>
): Promise<WatchMaps> {
  const tmdbIds = new Set<string>();
  const showRefs: SeerrShowRef[] = [];
  const usernames = new Set<string>();
  for (const acc of accumulators.values()) {
    for (const id of acc.movieRequestsByTmdb.keys()) tmdbIds.add(String(id));
    showRefs.push(...acc.seriesRefs);
    if (acc.mediaUsername) usernames.add(acc.mediaUsername);
  }

  const empty: WatchMaps = {
    watchedMoviesByUser: new Map(),
    watchedEpisodesByUser: new Map(),
    shows: await loadLocalShows([], []),
  };

  if (usernames.size === 0 || (tmdbIds.size === 0 && showRefs.length === 0)) {
    return empty;
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);
  if (serverIds.length === 0) return empty;

  // Canonical movies the user owns, keyed by tmdbId → set of dedupKeys.
  const movieMap = new Map<number, Set<string>>();
  if (tmdbIds.size > 0) {
    const movies = await prisma.mediaItem.findMany({
      where: {
        type: "MOVIE",
        dedupCanonical: true,
        library: { mediaServerId: { in: serverIds } },
        externalIds: { some: { source: "TMDB", externalId: { in: Array.from(tmdbIds) } } },
      },
      select: {
        dedupKey: true,
        externalIds: { where: { source: "TMDB" }, select: { externalId: true } },
      },
    });
    for (const m of movies) {
      const tmdbStr = m.externalIds[0]?.externalId;
      if (!tmdbStr || !m.dedupKey) continue;
      const tmdb = Number(tmdbStr);
      if (!Number.isFinite(tmdb)) continue;
      let set = movieMap.get(tmdb);
      if (!set) {
        set = new Set();
        movieMap.set(tmdb, set);
      }
      set.add(m.dedupKey);
    }
  }

  const shows = await loadLocalShows(serverIds, showRefs);

  // Build watch maps via WatchHistory rows for usernames of interest.
  const usernameList = Array.from(usernames);
  const watchedMoviesByUser = new Map<string, Set<number>>();
  const watchedEpisodesByUser = new Map<string, Map<string, Set<string>>>();

  // Watch history for movies — match by either canonical mediaItemId OR same dedupKey
  // (handles the case where the user watched on a non-canonical copy on another server).
  //
  // Both queries below filter to completed plays. The whole point of this stat
  // is "did the requester actually watch what they asked for" — a Tracearr row
  // with `watched = false` is someone starting it and giving up, which is the
  // opposite answer, and counting it would report a request as satisfied when
  // it demonstrably was not. Native rows carry a null `watched` and still
  // count, so the shared predicate leaves pre-Tracearr behaviour untouched.
  if (movieMap.size > 0) {
    const movieDedupKeys = new Set<string>();
    const tmdbByDedupKey = new Map<string, number>();
    for (const [tmdb, set] of movieMap.entries()) {
      for (const k of set) {
        movieDedupKeys.add(k);
        tmdbByDedupKey.set(k, tmdb);
      }
    }
    const rows = await prisma.watchHistory.findMany({
      where: {
        ...COMPLETED_PLAY_FILTER,
        serverUsername: { in: usernameList },
        mediaItem: {
          type: "MOVIE",
          dedupKey: { in: Array.from(movieDedupKeys) },
        },
      },
      select: {
        serverUsername: true,
        mediaItem: { select: { dedupKey: true } },
      },
    });
    for (const row of rows) {
      const dk = row.mediaItem.dedupKey;
      if (!dk) continue;
      const tmdb = tmdbByDedupKey.get(dk);
      if (tmdb == null) continue;
      let set = watchedMoviesByUser.get(row.serverUsername);
      if (!set) {
        set = new Set();
        watchedMoviesByUser.set(row.serverUsername, set);
      }
      set.add(tmdb);
    }
  }

  if (shows.shows.size > 0) {
    const showByDedupKey = new Map<string, string>();
    for (const show of shows.shows.values()) {
      for (const ep of show.episodes) if (ep.dedupKey) showByDedupKey.set(ep.dedupKey, show.seriesKey);
    }
    const rows = showByDedupKey.size === 0 ? [] : await prisma.watchHistory.findMany({
      where: {
        ...COMPLETED_PLAY_FILTER,
        serverUsername: { in: usernameList },
        mediaItem: {
          type: "SERIES",
          episodeNumber: { not: null },
          dedupKey: { in: Array.from(showByDedupKey.keys()) },
        },
      },
      select: {
        serverUsername: true,
        mediaItem: { select: { dedupKey: true } },
      },
    });
    for (const row of rows) {
      const dk = row.mediaItem.dedupKey;
      if (!dk) continue;
      const seriesKey = showByDedupKey.get(dk);
      if (seriesKey == null) continue;
      let perUser = watchedEpisodesByUser.get(row.serverUsername);
      if (!perUser) {
        perUser = new Map();
        watchedEpisodesByUser.set(row.serverUsername, perUser);
      }
      let perSeries = perUser.get(seriesKey);
      if (!perSeries) {
        perSeries = new Set();
        perUser.set(seriesKey, perSeries);
      }
      perSeries.add(dk);
    }
  }

  return { watchedMoviesByUser, watchedEpisodesByUser, shows };
}
