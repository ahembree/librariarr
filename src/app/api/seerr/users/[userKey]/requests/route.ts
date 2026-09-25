import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
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
} from "@/lib/seerr/library-match";
import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";

const CACHE_TTL_MS = 60_000;

interface ResolvedRequest {
  seerrId: number;
  seerrInstanceId: string;
  type: "movie" | "tv";
  status: number;
  mediaStatus: number;
  is4k: boolean;
  createdAt: string;
  tmdbId: number;
  tvdbId: number | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  mediaItem: { id: string; route: "movie" | "show" } | null;
  /** Library show identity for a TV request (null for movies / shows not in the library). */
  seriesKey: string | null;
  watch: {
    correlatable: boolean;
    watched: boolean;
    episodesWatched: number;
    episodesAvailable: number;
  };
}

interface ResolveResult {
  user: {
    seerrUsername: string;
    plexUsername: string | null;
    avatar: string | null;
  } | null;
  /** True when an instance's request list could not be read in full. */
  partial: boolean;
  requests: ResolvedRequest[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userKey: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Next.js has already URL-decoded dynamic params. Decoding again threw on a
  // key containing a literal '%' ("100%Dad" → 500) and rewrote a literal
  // "%41" to "A", resolving a different user.
  const { userKey } = await params;

  const cacheKey = `seerr-user-requests:${session.userId}:${userKey}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () => resolveUserRequests(session.userId!, userKey),
    CACHE_TTL_MS
  );
  if (result.partial) appCache.invalidate(cacheKey);
  return NextResponse.json(result);
}

async function resolveUserRequests(
  userId: string,
  userKey: string
): Promise<ResolveResult> {
  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (instances.length === 0) {
    return { user: null, partial: false, requests: [] };
  }

  let userInfo: ResolveResult["user"] = null;
  let mediaUsername: string | null = null;
  let partial = false;
  const matched: { req: SeerrRequest; instanceId: string }[] = [];
  // Clients for instances whose walk succeeded — title/poster lookups for
  // requests not in the library go to the instance the request came from.
  const clients = new Map<string, SeerrClient>();

  // Walked at once and failing fast, like the stats card this drills into (see
  // computeSeerrRequestStats): a dead instance costs one timeout, not its
  // retry budget, and does not hold the others back. Folded in instance order.
  const walks = await Promise.all(
    instances.map(async (inst) => {
      const client = new SeerrClient(inst.url, inst.apiKey);
      const fromInstance: SeerrRequest[] = [];
      try {
        await walkSeerrRequests(client, { instanceName: inst.name, failFast: true }, (req) => {
          // Same identity the stats card keys its rows on — see seerrRequesterKey.
          if (seerrRequesterKey(req.requestedBy) === userKey) fromInstance.push(req);
        });
        return { inst, client, fromInstance };
      } catch (error) {
        logger.warn(
          "Seerr",
          `Failed to fetch requests from ${inst.name} for user ${userKey}`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        return null;
      }
    }),
  );

  for (const walk of walks) {
    if (!walk) {
      partial = true;
      continue;
    }
    const { inst, client, fromInstance } = walk;
    clients.set(inst.id, client);
    for (const req of fromInstance) {
      const r = req.requestedBy;
      matched.push({ req, instanceId: inst.id });
      if (!userInfo) {
        userInfo = {
          seerrUsername: r.username || r.plexUsername || r.jellyfinUsername || r.email,
          plexUsername: r.plexUsername ?? null,
          avatar: r.avatar ?? null,
        };
      }
      // Adopt identity fields a later requester supplies, so correlation does
      // not depend on which instance or request happened to come first.
      if (userInfo.plexUsername == null && r.plexUsername) userInfo.plexUsername = r.plexUsername;
      if (userInfo.avatar == null && r.avatar) userInfo.avatar = r.avatar;
      if (mediaUsername == null) mediaUsername = seerrMediaUsername(r);
    }
  }

  if (matched.length === 0) {
    return { user: userInfo, partial, requests: [] };
  }

  const tmdbIds = new Set<string>();
  const showRefs: { tvdbId: number | null; tmdbId: number | null }[] = [];
  for (const { req } of matched) {
    if (req.type === "movie" && req.media?.tmdbId) tmdbIds.add(String(req.media.tmdbId));
    if (req.type === "tv" && (req.media?.tvdbId || req.media?.tmdbId)) {
      showRefs.push({ tvdbId: req.media.tvdbId, tmdbId: req.media.tmdbId });
    }
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  // Movies: tmdbId -> matched MediaItem
  const movieMap = new Map<
    number,
    { id: string; title: string; year: number | null; dedupKey: string | null }
  >();
  const movieDedupToTmdb = new Map<string, number>();
  if (tmdbIds.size > 0 && serverIds.length > 0) {
    const movies = await prisma.mediaItem.findMany({
      where: {
        type: "MOVIE",
        dedupCanonical: true,
        library: { mediaServerId: { in: serverIds } },
        externalIds: { some: { source: "TMDB", externalId: { in: Array.from(tmdbIds) } } },
      },
      select: {
        id: true,
        title: true,
        year: true,
        dedupKey: true,
        externalIds: { where: { source: "TMDB" }, select: { externalId: true } },
      },
    });
    for (const m of movies) {
      const tmdbStr = m.externalIds[0]?.externalId;
      if (!tmdbStr) continue;
      const tmdb = Number(tmdbStr);
      if (!Number.isFinite(tmdb)) continue;
      if (!movieMap.has(tmdb)) {
        movieMap.set(tmdb, { id: m.id, title: m.title, year: m.year, dedupKey: m.dedupKey });
        if (m.dedupKey) movieDedupToTmdb.set(m.dedupKey, tmdb);
      }
    }
  }

  // Series: matched by TVDB or TMDB id and grouped by seriesKey. Links go to
  // a representative episode — the sync stores episodes, not show-level items.
  const shows = await loadLocalShows(serverIds, showRefs);
  const seriesDedupToShow = new Map<string, string>();
  for (const show of shows.shows.values()) {
    for (const ep of show.episodes) if (ep.dedupKey) seriesDedupToShow.set(ep.dedupKey, show.seriesKey);
  }

  // Watch correlation via WatchHistory + dedupKey.
  const watchedMovieTmdbs = new Set<number>();
  const watchedEpisodesByShow = new Map<string, Set<string>>();
  if (mediaUsername && (movieDedupToTmdb.size > 0 || seriesDedupToShow.size > 0)) {
    const allDedupKeys = [
      ...Array.from(movieDedupToTmdb.keys()),
      ...Array.from(seriesDedupToShow.keys()),
    ];
    if (allDedupKeys.length > 0) {
      const watched = await prisma.watchHistory.findMany({
        where: {
          // Must match `request-stats.ts`, which computes the aggregate
          // "watched" counts over this same table for this same user: without
          // the predicate, a 4%-complete abandoned Tracearr play marks a request
          // as watched here while the summary that sits beside it says it was
          // not. Two views of one fact, disagreeing.
          ...COMPLETED_PLAY_FILTER,
          serverUsername: mediaUsername,
          mediaItem: { dedupKey: { in: allDedupKeys } },
        },
        select: { mediaItem: { select: { dedupKey: true } } },
      });
      for (const row of watched) {
        const dk = row.mediaItem.dedupKey;
        if (!dk) continue;
        const tmdb = movieDedupToTmdb.get(dk);
        if (tmdb != null) {
          watchedMovieTmdbs.add(tmdb);
          continue;
        }
        const seriesKey = seriesDedupToShow.get(dk);
        if (seriesKey != null) {
          let set = watchedEpisodesByShow.get(seriesKey);
          if (!set) {
            set = new Set();
            watchedEpisodesByShow.set(seriesKey, set);
          }
          set.add(dk);
        }
      }
    }
  }

  // For requests not in the library, fetch title/poster from Seerr in parallel.
  // Keyed by TMDB id (always present on Seerr requests; TVDB can be null/0 for
  // shows Seerr couldn't match), so we still get titles for those edge cases.
  // tmdbId → the instance a request for it came from (its walk succeeded).
  const missingMovieTmdbs = new Map<number, string>();
  const missingTvTmdbs = new Map<number, string>();
  for (const { req, instanceId } of matched) {
    if (!req.media?.tmdbId) continue;
    if (req.type === "movie") {
      if (!movieMap.has(req.media.tmdbId) && !missingMovieTmdbs.has(req.media.tmdbId)) {
        missingMovieTmdbs.set(req.media.tmdbId, instanceId);
      }
    } else if (req.type === "tv") {
      if (!shows.resolve(req.media) && !missingTvTmdbs.has(req.media.tmdbId)) {
        missingTvTmdbs.set(req.media.tmdbId, instanceId);
      }
    }
  }

  const seerrMovieDetails = new Map<
    number,
    { title: string | null; year: number | null; posterUrl: string | null }
  >();
  const seerrTvDetailsByTmdb = new Map<
    number,
    { title: string | null; year: number | null; posterUrl: string | null }
  >();

  if (missingMovieTmdbs.size > 0 || missingTvTmdbs.size > 0) {
    const movieFetches = Array.from(missingMovieTmdbs).map(async ([tmdb, instanceId]) => {
      const client = clients.get(instanceId);
      if (!client) return;
      try {
        const detail = await client.getMovie(tmdb);
        const year = detail.releaseDate ? Number(detail.releaseDate.slice(0, 4)) : null;
        seerrMovieDetails.set(tmdb, {
          title: detail.title ?? null,
          year: Number.isFinite(year) ? year : null,
          posterUrl: tmdbPosterUrl(detail.posterPath),
        });
      } catch {
        // ignore; fall back to placeholder label
      }
    });
    const tvFetches = Array.from(missingTvTmdbs).map(async ([tmdb, instanceId]) => {
      const client = clients.get(instanceId);
      if (!client) return;
      try {
        const detail = await client.getTvShow(tmdb);
        const year = detail.firstAirDate ? Number(detail.firstAirDate.slice(0, 4)) : null;
        seerrTvDetailsByTmdb.set(tmdb, {
          title: detail.name ?? null,
          year: Number.isFinite(year) ? year : null,
          posterUrl: tmdbPosterUrl(detail.posterPath),
        });
      } catch {
        // ignore
      }
    });
    await Promise.all([...movieFetches, ...tvFetches]);
  }

  const resolved: ResolvedRequest[] = [];
  for (const { req, instanceId } of matched) {
    if (req.type === "movie") {
      const tmdb = req.media?.tmdbId ?? 0;
      const local = movieMap.get(tmdb);
      const fallback = seerrMovieDetails.get(tmdb);
      resolved.push({
        seerrId: req.id,
        seerrInstanceId: instanceId,
        type: "movie",
        status: req.status,
        mediaStatus: requestMediaStatus(req),
        is4k: req.is4k ?? false,
        createdAt: req.createdAt,
        tmdbId: tmdb,
        tvdbId: null,
        title: local?.title ?? fallback?.title ?? `Movie (TMDB ${tmdb})`,
        year: local?.year ?? fallback?.year ?? null,
        posterUrl: local ? `/api/media/${local.id}/image` : fallback?.posterUrl ?? null,
        mediaItem: local ? { id: local.id, route: "movie" } : null,
        seriesKey: null,
        watch: {
          correlatable: mediaUsername != null,
          watched: watchedMovieTmdbs.has(tmdb),
          episodesWatched: 0,
          episodesAvailable: 0,
        },
      });
    } else {
      const tvdb = req.media?.tvdbId ?? 0;
      const tmdb = req.media?.tmdbId ?? 0;
      const local = req.media ? shows.resolve(req.media) : undefined;
      const fallback = tmdb > 0 ? seerrTvDetailsByTmdb.get(tmdb) : undefined;
      const episodesAvailable = local ? countShowEpisodes(local) : 0;
      const episodesWatched = local ? watchedEpisodesByShow.get(local.seriesKey)?.size ?? 0 : 0;
      resolved.push({
        seerrId: req.id,
        seerrInstanceId: instanceId,
        type: "tv",
        status: req.status,
        mediaStatus: requestMediaStatus(req),
        is4k: req.is4k ?? false,
        createdAt: req.createdAt,
        tmdbId: tmdb,
        tvdbId: tvdb > 0 ? tvdb : null,
        title:
          local?.title ??
          fallback?.title ??
          (tvdb > 0 ? `Series (TVDB ${tvdb})` : tmdb > 0 ? `Series (TMDB ${tmdb})` : "Series"),
        // Year on episodes is the episode's air year, not the show's — only use the
        // Seerr-supplied first-air year so we don't show misleading season-specific years.
        year: fallback?.year ?? null,
        posterUrl: local?.representativeEpisodeId
          ? `/api/media/${local.representativeEpisodeId}/image?type=parent`
          : fallback?.posterUrl ?? null,
        mediaItem: local?.representativeEpisodeId
          ? { id: local.representativeEpisodeId, route: "show" }
          : null,
        seriesKey: local?.seriesKey ?? null,
        watch: {
          correlatable: mediaUsername != null,
          watched: episodesWatched > 0,
          episodesWatched,
          episodesAvailable,
        },
      });
    }
  }

  resolved.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return { user: userInfo, partial, requests: resolved };
}

/**
 * The media status a request refers to. Seerr tracks the 4K copy separately
 * (`status4k`), so a 4K request for a film already available in HD must not
 * read as available.
 */
function requestMediaStatus(req: SeerrRequest): number {
  return (req.is4k ? req.media?.status4k ?? req.media?.status : req.media?.status) ?? 1;
}

function tmdbPosterUrl(posterPath: string | null | undefined): string | null {
  if (!posterPath) return null;
  if (posterPath.startsWith("http")) return posterPath;
  return `https://image.tmdb.org/t/p/w154${posterPath}`;
}
