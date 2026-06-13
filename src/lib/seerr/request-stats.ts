import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";

const REQUEST_PAGE_SIZE = 100;
const STATS_TTL_MS = 60_000;
// Hard ceiling on Seerr request pagination so a huge or looping instance can't
// hang the request indefinitely. 1000 pages × 100 per page = 100k requests.
const MAX_REQUEST_PAGES = 1000;

export interface SeerrUserRequestStats {
  /** Stable identity key — plexUsername when present, otherwise Seerr username. */
  userKey: string;
  seerrUsername: string;
  plexUsername: string | null;
  avatar: string | null;
  requestCount: number;
  movieCount: number;
  seriesCount: number;
  moviesWatched: number;
  seriesWithAnyEpisodeWatched: number;
  episodesWatched: number;
  episodesAvailable: number;
  /** False when the user has no plexUsername (no watch correlation possible). */
  correlatable: boolean;
}

export interface SeerrRequestStatsResult {
  configured: boolean;
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
  avatar: string | null;
  total: number;
  movies: number;
  series: number;
  movieTmdbIds: Set<number>;
  seriesTvdbIds: Set<number>;
}

export async function getSeerrRequestStats(
  userId: string
): Promise<SeerrRequestStatsResult> {
  const cacheKey = `seerr-request-stats:${userId}`;
  return appCache.getOrSet(cacheKey, () => computeSeerrRequestStats(userId), STATS_TTL_MS);
}

export function invalidateSeerrRequestStats(userId: string): void {
  appCache.invalidate(`seerr-request-stats:${userId}`);
}

async function computeSeerrRequestStats(
  userId: string
): Promise<SeerrRequestStatsResult> {
  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
  });

  if (instances.length === 0) {
    return {
      configured: false,
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

  for (const instance of instances) {
    const client = new SeerrClient(instance.url, instance.apiKey);
    let skip = 0;
    let pages = 0;
    while (true) {
      if (pages >= MAX_REQUEST_PAGES) {
        logger.warn(
          "Seerr",
          `Request pagination hit MAX_REQUEST_PAGES (${MAX_REQUEST_PAGES}) for ${instance.name} during stats — truncating`
        );
        break;
      }
      let page;
      try {
        page = await client.getRequests({ take: REQUEST_PAGE_SIZE, skip });
      } catch (error) {
        logger.warn(
          "Seerr",
          `Failed to fetch requests from ${instance.name} for stats`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        break;
      }
      pages += 1;
      for (const req of page.results) {
        const requester = req.requestedBy;
        if (!requester) continue;
        const key = requester.plexUsername || requester.username || requester.email;
        if (!key) continue;
        let acc = accumulators.get(key);
        if (!acc) {
          acc = {
            seerrUsername: requester.username || requester.plexUsername || requester.email,
            plexUsername: requester.plexUsername ?? null,
            avatar: requester.avatar ?? null,
            total: 0,
            movies: 0,
            series: 0,
            movieTmdbIds: new Set(),
            seriesTvdbIds: new Set(),
          };
          accumulators.set(key, acc);
        }
        acc.total++;
        if (req.type === "movie") {
          acc.movies++;
          if (req.media?.tmdbId) acc.movieTmdbIds.add(req.media.tmdbId);
        } else if (req.type === "tv") {
          acc.series++;
          if (req.media?.tvdbId) acc.seriesTvdbIds.add(req.media.tvdbId);
        }
      }
      if (page.results.length < REQUEST_PAGE_SIZE) break;
      skip += REQUEST_PAGE_SIZE;
    }
  }

  const watchMaps = await buildWatchMaps(userId, accumulators);

  const users: SeerrUserRequestStats[] = [];
  for (const [userKey, acc] of accumulators.entries()) {
    const correlatable = acc.plexUsername != null;
    let moviesWatched = 0;
    let seriesWithAnyEpisodeWatched = 0;
    let episodesWatched = 0;
    let episodesAvailable = 0;

    if (correlatable) {
      const movieKeys = watchMaps.watchedMoviesByUser.get(acc.plexUsername!) ?? new Set<number>();
      for (const tmdb of acc.movieTmdbIds) {
        if (movieKeys.has(tmdb)) moviesWatched++;
      }

      const seriesWatch = watchMaps.watchedEpisodesByUser.get(acc.plexUsername!);
      for (const tvdb of acc.seriesTvdbIds) {
        const totals = watchMaps.episodeTotalsByTvdb.get(tvdb);
        if (!totals) continue;
        episodesAvailable += totals.total;
        const watchedSet = seriesWatch?.get(tvdb);
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

  return { configured: true, users, totals };
}

interface WatchMaps {
  /** plexUsername → set of TMDB IDs the user has watched. */
  watchedMoviesByUser: Map<string, Set<number>>;
  /** plexUsername → (TVDB ID → set of canonical episode dedupKeys watched). */
  watchedEpisodesByUser: Map<string, Map<number, Set<string>>>;
  /** TVDB ID → { total canonical episodes available }. */
  episodeTotalsByTvdb: Map<number, { total: number }>;
}

async function buildWatchMaps(
  userId: string,
  accumulators: Map<string, UserAccumulator>
): Promise<WatchMaps> {
  const tmdbIds = new Set<string>();
  const tvdbIds = new Set<string>();
  const usernames = new Set<string>();
  for (const acc of accumulators.values()) {
    for (const id of acc.movieTmdbIds) tmdbIds.add(String(id));
    for (const id of acc.seriesTvdbIds) tvdbIds.add(String(id));
    if (acc.plexUsername) usernames.add(acc.plexUsername);
  }

  const empty: WatchMaps = {
    watchedMoviesByUser: new Map(),
    watchedEpisodesByUser: new Map(),
    episodeTotalsByTvdb: new Map(),
  };

  if (usernames.size === 0 || (tmdbIds.size === 0 && tvdbIds.size === 0)) {
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

  // Canonical series episodes the user owns, grouped by tvdbId.
  // Returns: tvdbId → Set of canonical episode dedupKeys (= total episode count when sized)
  const episodeMap = new Map<
    number,
    { dedupKeys: Set<string>; allIds: Set<string> }
  >();
  if (tvdbIds.size > 0) {
    const episodes = await prisma.mediaItem.findMany({
      where: {
        type: "SERIES",
        episodeNumber: { not: null },
        dedupCanonical: true,
        library: { mediaServerId: { in: serverIds } },
        externalIds: { some: { source: "TVDB", externalId: { in: Array.from(tvdbIds) } } },
      },
      select: {
        id: true,
        dedupKey: true,
        externalIds: { where: { source: "TVDB" }, select: { externalId: true } },
      },
    });
    for (const ep of episodes) {
      const tvdbStr = ep.externalIds[0]?.externalId;
      if (!tvdbStr) continue;
      const tvdb = Number(tvdbStr);
      if (!Number.isFinite(tvdb)) continue;
      let entry = episodeMap.get(tvdb);
      if (!entry) {
        entry = { dedupKeys: new Set(), allIds: new Set() };
        episodeMap.set(tvdb, entry);
      }
      if (ep.dedupKey) entry.dedupKeys.add(ep.dedupKey);
      entry.allIds.add(ep.id);
    }
  }

  // Build watch maps via WatchHistory rows for usernames of interest.
  const usernameList = Array.from(usernames);
  const watchedMoviesByUser = new Map<string, Set<number>>();
  const watchedEpisodesByUser = new Map<string, Map<number, Set<string>>>();

  // Watch history for movies — match by either canonical mediaItemId OR same dedupKey
  // (handles the case where the user watched on a non-canonical copy on another server).
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

  if (episodeMap.size > 0) {
    const epDedupKeys = new Set<string>();
    for (const entry of episodeMap.values()) {
      for (const k of entry.dedupKeys) epDedupKeys.add(k);
    }
    const tvdbByDedupKey = new Map<string, number>();
    for (const [tvdb, entry] of episodeMap.entries()) {
      for (const k of entry.dedupKeys) tvdbByDedupKey.set(k, tvdb);
    }
    const rows = await prisma.watchHistory.findMany({
      where: {
        serverUsername: { in: usernameList },
        mediaItem: {
          type: "SERIES",
          episodeNumber: { not: null },
          dedupKey: { in: Array.from(epDedupKeys) },
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
      const tvdb = tvdbByDedupKey.get(dk);
      if (tvdb == null) continue;
      let perUser = watchedEpisodesByUser.get(row.serverUsername);
      if (!perUser) {
        perUser = new Map();
        watchedEpisodesByUser.set(row.serverUsername, perUser);
      }
      let perSeries = perUser.get(tvdb);
      if (!perSeries) {
        perSeries = new Set();
        perUser.set(tvdb, perSeries);
      }
      perSeries.add(dk);
    }
  }

  const episodeTotalsByTvdb = new Map<number, { total: number }>();
  for (const [tvdb, entry] of episodeMap.entries()) {
    // Prefer dedupKey-based unique count; fall back to id count when dedupKey is missing.
    const total = entry.dedupKeys.size > 0 ? entry.dedupKeys.size : entry.allIds.size;
    episodeTotalsByTvdb.set(tvdb, { total });
  }

  return { watchedMoviesByUser, watchedEpisodesByUser, episodeTotalsByTvdb };
}
