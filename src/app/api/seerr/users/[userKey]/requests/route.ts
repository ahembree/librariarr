import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient, type SeerrRequest } from "@/lib/seerr/seerr-client";
import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";

const PAGE_SIZE = 100;
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
  const { userKey } = await params;
  const decoded = decodeURIComponent(userKey);

  const cacheKey = `seerr-user-requests:${session.userId}:${decoded}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () => resolveUserRequests(session.userId!, decoded),
    CACHE_TTL_MS
  );
  return NextResponse.json(result);
}

async function resolveUserRequests(
  userId: string,
  userKey: string
): Promise<ResolveResult> {
  const instances = await prisma.seerrInstance.findMany({
    where: { userId, enabled: true },
  });
  if (instances.length === 0) {
    return { user: null, requests: [] };
  }

  let userInfo: ResolveResult["user"] = null;
  const matched: { req: SeerrRequest; instanceId: string }[] = [];

  for (const inst of instances) {
    const client = new SeerrClient(inst.url, inst.apiKey);
    let skip = 0;
    while (true) {
      let page;
      try {
        page = await client.getRequests({ take: PAGE_SIZE, skip });
      } catch (error) {
        logger.warn(
          "Seerr",
          `Failed to fetch requests from ${inst.name} for user ${userKey}`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        break;
      }
      for (const req of page.results) {
        const r = req.requestedBy;
        if (!r) continue;
        const candidateKeys = [r.plexUsername, r.username, r.email].filter(
          Boolean
        ) as string[];
        if (!candidateKeys.includes(userKey)) continue;
        matched.push({ req, instanceId: inst.id });
        if (!userInfo) {
          userInfo = {
            seerrUsername: r.username || r.plexUsername || r.email,
            plexUsername: r.plexUsername ?? null,
            avatar: r.avatar ?? null,
          };
        }
      }
      if (page.results.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }
  }

  if (matched.length === 0) {
    return { user: userInfo, requests: [] };
  }

  const tmdbIds = new Set<string>();
  const tvdbIds = new Set<string>();
  for (const { req } of matched) {
    if (req.type === "movie" && req.media?.tmdbId) tmdbIds.add(String(req.media.tmdbId));
    if (req.type === "tv" && req.media?.tvdbId) tvdbIds.add(String(req.media.tvdbId));
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

  // Series: tvdbId -> { representative episode id (used as link target since
  // Librariarr's sync only stores episodes, not show-level items, for TV
  // libraries — show detail page resolves the show via the episode's parentTitle),
  // title, episodes list (for watch correlation). }
  interface SeriesEntry {
    representativeEpisodeId: string | null;
    title: string | null;
    episodes: { id: string; dedupKey: string | null }[];
  }
  const seriesMap = new Map<number, SeriesEntry>();
  const seriesDedupToTvdb = new Map<string, number>();

  if (tvdbIds.size > 0 && serverIds.length > 0) {
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
        parentTitle: true,
        externalIds: { where: { source: "TVDB" }, select: { externalId: true } },
      },
      orderBy: [{ seasonNumber: "asc" }, { episodeNumber: "asc" }],
    });

    for (const ep of episodes) {
      const tvdbStr = ep.externalIds[0]?.externalId;
      if (!tvdbStr) continue;
      const tvdb = Number(tvdbStr);
      if (!Number.isFinite(tvdb)) continue;
      let entry = seriesMap.get(tvdb);
      if (!entry) {
        entry = {
          representativeEpisodeId: ep.id,
          title: ep.parentTitle,
          episodes: [],
        };
        seriesMap.set(tvdb, entry);
      }
      entry.episodes.push({ id: ep.id, dedupKey: ep.dedupKey });
      if (ep.dedupKey) seriesDedupToTvdb.set(ep.dedupKey, tvdb);
      if (!entry.title && ep.parentTitle) entry.title = ep.parentTitle;
    }
  }

  // Watch correlation via WatchHistory + dedupKey.
  const watchedMovieTmdbs = new Set<number>();
  const watchedEpisodesByTvdb = new Map<number, Set<string>>();
  const plexUsername = userInfo?.plexUsername ?? null;
  if (plexUsername && (movieDedupToTmdb.size > 0 || seriesDedupToTvdb.size > 0)) {
    const allDedupKeys = [
      ...Array.from(movieDedupToTmdb.keys()),
      ...Array.from(seriesDedupToTvdb.keys()),
    ];
    if (allDedupKeys.length > 0) {
      const watched = await prisma.watchHistory.findMany({
        where: {
          serverUsername: plexUsername,
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
        const tvdb = seriesDedupToTvdb.get(dk);
        if (tvdb != null) {
          let set = watchedEpisodesByTvdb.get(tvdb);
          if (!set) {
            set = new Set();
            watchedEpisodesByTvdb.set(tvdb, set);
          }
          set.add(dk);
        }
      }
    }
  }

  // For requests not in the library, fetch title/poster from Seerr in parallel.
  // Keyed by TMDB id (always present on Seerr requests; TVDB can be null/0 for
  // shows Seerr couldn't match), so we still get titles for those edge cases.
  const missingMovieTmdbs = new Set<number>();
  const missingTvTmdbs = new Set<number>();
  for (const { req } of matched) {
    if (req.type === "movie") {
      if (!req.media?.tmdbId) continue;
      if (!movieMap.has(req.media.tmdbId)) missingMovieTmdbs.add(req.media.tmdbId);
    } else if (req.type === "tv") {
      if (!req.media?.tmdbId) continue;
      const tvdb = req.media.tvdbId;
      const inLibrary = tvdb != null && tvdb !== 0 && seriesMap.has(tvdb);
      if (!inLibrary) missingTvTmdbs.add(req.media.tmdbId);
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
    const firstInstance = instances[0];
    const client = new SeerrClient(firstInstance.url, firstInstance.apiKey);
    const movieFetches = Array.from(missingMovieTmdbs).map(async (tmdb) => {
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
    const tvFetches = Array.from(missingTvTmdbs).map(async (tmdb) => {
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
        mediaStatus: req.media?.status ?? 1,
        is4k: req.is4k ?? false,
        createdAt: req.createdAt,
        tmdbId: tmdb,
        tvdbId: null,
        title: local?.title ?? fallback?.title ?? `Movie (TMDB ${tmdb})`,
        year: local?.year ?? fallback?.year ?? null,
        posterUrl: local ? `/api/media/${local.id}/image` : fallback?.posterUrl ?? null,
        mediaItem: local ? { id: local.id, route: "movie" } : null,
        watch: {
          correlatable: plexUsername != null,
          watched: watchedMovieTmdbs.has(tmdb),
          episodesWatched: 0,
          episodesAvailable: 0,
        },
      });
    } else {
      const tvdb = req.media?.tvdbId ?? 0;
      const tmdb = req.media?.tmdbId ?? 0;
      const local = tvdb > 0 ? seriesMap.get(tvdb) : undefined;
      const fallback = tmdb > 0 ? seerrTvDetailsByTmdb.get(tmdb) : undefined;
      const episodesAvailable = local?.episodes.length ?? 0;
      const episodesWatched = tvdb > 0 ? watchedEpisodesByTvdb.get(tvdb)?.size ?? 0 : 0;
      resolved.push({
        seerrId: req.id,
        seerrInstanceId: instanceId,
        type: "tv",
        status: req.status,
        mediaStatus: req.media?.status ?? 1,
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
        watch: {
          correlatable: plexUsername != null,
          watched: episodesWatched > 0,
          episodesWatched,
          episodesAvailable,
        },
      });
    }
  }

  resolved.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return { user: userInfo, requests: resolved };
}

function tmdbPosterUrl(posterPath: string | null | undefined): string | null {
  if (!posterPath) return null;
  if (posterPath.startsWith("http")) return posterPath;
  return `https://image.tmdb.org/t/p/w154${posterPath}`;
}
