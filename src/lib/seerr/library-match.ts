import { prisma } from "@/lib/db";
import { resolveSeriesKey } from "@/lib/media/series-key";

/** A TV request's show identity as Seerr knows it. Either id may be absent. */
export interface SeerrShowRef {
  tvdbId: number | null | undefined;
  tmdbId: number | null | undefined;
}

export interface LocalShow {
  /** `MediaItem.seriesKey` of the matched episodes — one entry per show. */
  seriesKey: string;
  title: string | null;
  representativeEpisodeId: string;
  /** Canonical episodes in the library (first-aired order). */
  episodes: { id: string; dedupKey: string | null }[];
}

export interface LocalShowIndex {
  shows: Map<string, LocalShow>;
  /** Resolve a Seerr TV request to a library show — TVDB first, then TMDB. */
  resolve(ref: SeerrShowRef): LocalShow | undefined;
}

/**
 * Library shows matching a set of Seerr TV requests. Matched by TVDB **or**
 * TMDB id (the precedence `lookupSeerrMeta` uses): Seerr's `media.tvdbId` is
 * nullable, and a Jellyfin library without the TVDB provider stores only
 * TMDB/IMDB ids, so matching on TVDB alone reported such shows as "not in
 * your library" while the lifecycle engine — which tries both — treated them
 * as requested. Episodes group by `seriesKey`, so a show reached through
 * either id is counted once.
 */
export async function loadLocalShows(
  serverIds: string[],
  refs: Iterable<SeerrShowRef>,
): Promise<LocalShowIndex> {
  const tvdbIds = new Set<string>();
  const tmdbIds = new Set<string>();
  for (const ref of refs) {
    if (ref.tvdbId) tvdbIds.add(String(ref.tvdbId));
    if (ref.tmdbId) tmdbIds.add(String(ref.tmdbId));
  }

  const shows = new Map<string, LocalShow>();
  const byExternal = new Map<string, string>();
  const index: LocalShowIndex = {
    shows,
    resolve(ref) {
      const key =
        (ref.tvdbId ? byExternal.get(`TVDB:${ref.tvdbId}`) : undefined) ??
        (ref.tmdbId ? byExternal.get(`TMDB:${ref.tmdbId}`) : undefined);
      return key ? shows.get(key) : undefined;
    },
  };
  if (serverIds.length === 0 || (tvdbIds.size === 0 && tmdbIds.size === 0)) return index;

  const idFilters = [
    ...(tvdbIds.size > 0 ? [{ source: "TVDB", externalId: { in: Array.from(tvdbIds) } }] : []),
    ...(tmdbIds.size > 0 ? [{ source: "TMDB", externalId: { in: Array.from(tmdbIds) } }] : []),
  ];
  const episodes = await prisma.mediaItem.findMany({
    where: {
      type: "SERIES",
      episodeNumber: { not: null },
      dedupCanonical: true,
      library: { mediaServerId: { in: serverIds } },
      externalIds: { some: { OR: idFilters } },
    },
    select: {
      id: true,
      dedupKey: true,
      parentTitle: true,
      seriesKey: true,
      externalIds: {
        where: { source: { in: ["TVDB", "TMDB"] } },
        select: { source: true, externalId: true },
      },
    },
    orderBy: [{ seasonNumber: "asc" }, { episodeNumber: "asc" }],
  });

  for (const ep of episodes) {
    const seriesKey = resolveSeriesKey(ep);
    if (!seriesKey) continue;
    let show = shows.get(seriesKey);
    if (!show) {
      show = { seriesKey, title: ep.parentTitle, representativeEpisodeId: ep.id, episodes: [] };
      shows.set(seriesKey, show);
    }
    show.episodes.push({ id: ep.id, dedupKey: ep.dedupKey });
    if (!show.title && ep.parentTitle) show.title = ep.parentTitle;
    for (const ext of ep.externalIds) {
      const k = `${ext.source.toUpperCase()}:${ext.externalId}`;
      if (!byExternal.has(k)) byExternal.set(k, seriesKey);
    }
  }
  return index;
}

/** Distinct episodes of a show — by dedupKey where the rows carry one. */
export function countShowEpisodes(show: LocalShow): number {
  const keys = new Set<string>();
  for (const ep of show.episodes) if (ep.dedupKey) keys.add(ep.dedupKey);
  return keys.size > 0 ? keys.size : show.episodes.length;
}
