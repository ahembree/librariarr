/**
 * Computes a deterministic dedup key for a media item.
 *
 * The key identifies the same content across different servers so that
 * duplicates can be detected at the database level (via the dedupKey column)
 * instead of fetching all items and deduplicating in JavaScript.
 *
 * Key priority for movies: TMDB > IMDB > title+year
 * Series episodes: TVDB + season+episode > parentTitle + season+episode
 * Music tracks: parentTitle (artist) + albumTitle + track title
 */

/**
 * Every track key starts with this. The key named no album before
 * (`music:<artist>:<title>`); `runBackfillIfNeeded` re-keys a row still
 * carrying that shape, which this prefix tells apart from the current one.
 */
export const TRACK_DEDUP_KEY_PREFIX = "track:";
export const LEGACY_TRACK_DEDUP_KEY_PREFIX = "music:";

export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeDedupKey(
  type: "MOVIE" | "SERIES" | "MUSIC",
  title: string,
  opts: {
    year?: number | null;
    parentTitle?: string | null;
    /** A track's album. Read for MUSIC only. */
    albumTitle?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    externalIds?: { source: string; id: string }[];
  } = {},
): string {
  if (type === "MOVIE") {
    const tmdb = opts.externalIds?.find(
      (e) => e.source.toLowerCase() === "tmdb",
    )?.id;
    if (tmdb) return `movie:tmdb:${tmdb}`;

    const imdb = opts.externalIds?.find(
      (e) => e.source.toLowerCase() === "imdb",
    )?.id;
    if (imdb) return `movie:imdb:${imdb}`;

    return `movie:title:${normalizeTitle(title)}:${opts.year ?? ""}`;
  }

  if (type === "SERIES") {
    const tvdb = opts.externalIds?.find(
      (e) => e.source.toLowerCase() === "tvdb",
    )?.id;
    const parent = tvdb
      ? `tvdb:${tvdb}`
      : opts.parentTitle
        ? normalizeTitle(opts.parentTitle)
        : normalizeTitle(title);
    return `series:${parent}:s${opts.seasonNumber ?? 0}e${opts.episodeNumber ?? 0}`;
  }

  if (type === "MUSIC") {
    // The album is part of a track's identity: without it a song's studio,
    // live and compilation versions — or two "Intro" tracks by one artist on
    // different albums — shared one key, and every deduplicated listing showed
    // only the canonical one of them, even on a single server.
    const parent = opts.parentTitle
      ? normalizeTitle(opts.parentTitle)
      : "unknown";
    const album = opts.albumTitle
      ? normalizeTitle(opts.albumTitle)
      : "unknown";
    return `${TRACK_DEDUP_KEY_PREFIX}${parent}:${album}:${normalizeTitle(title)}`;
  }

  return `title:${normalizeTitle(title)}:${opts.year ?? ""}`;
}
