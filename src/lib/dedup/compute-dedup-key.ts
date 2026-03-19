/**
 * Computes a deterministic dedup key for a media item.
 *
 * The key identifies the same content across different servers so that
 * duplicates can be detected at the database level (via the dedupKey column)
 * instead of fetching all items and deduplicating in JavaScript.
 *
 * Key priority for movies: TMDB > IMDB > title+year
 * Series episodes: TVDB + season+episode > parentTitle + season+episode
 * Music tracks: parentTitle (artist) + track title
 */

export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeDedupKey(
  type: "MOVIE" | "SERIES" | "MUSIC",
  title: string,
  opts: {
    year?: number | null;
    parentTitle?: string | null;
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
    const parent = opts.parentTitle
      ? normalizeTitle(opts.parentTitle)
      : "unknown";
    return `music:${parent}:${normalizeTitle(title)}`;
  }

  return `title:${normalizeTitle(title)}:${opts.year ?? ""}`;
}
