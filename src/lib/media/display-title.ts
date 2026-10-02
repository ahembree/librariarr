/**
 * How a media item is NAMED to a person — in a log line, a notification, an
 * error message or on screen. Client-safe (no server imports), so the UI names
 * items through the same functions as the logs.
 *
 * Librariarr stores episodes, not shows: an episode row's own `title` is the
 * EPISODE's name ("Pilot") and its show is `parentTitle`. Read alone, that name
 * says nothing about which show it belongs to, and read where the show is meant
 * — a series action, match or group, each stored against one representative
 * episode — it names the wrong thing outright. So:
 *  - anything that acts on or describes a SHOW is named by the show
 *    (`seriesTitleOf`), never by a representative episode's own title;
 *  - anything that targets ONE EPISODE is named by its show and its SxxExx
 *    code (`formatEpisodeTitle`: "Breaking Bad S01E01").
 */

export interface EpisodeTitleParts {
  /** The episode's own title. */
  title?: string | null;
  /** The show's title. */
  parentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export interface MediaTitleParts extends EpisodeTitleParts {
  /** `MediaItem.type` — a `SERIES` row is an episode. */
  type?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "S01E02" — "S01" or "E02" when only one number is known, null when neither is. */
export function formatEpisodeCode(
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
): string | null {
  const season = seasonNumber != null ? `S${pad2(seasonNumber)}` : "";
  const episode = episodeNumber != null ? `E${pad2(episodeNumber)}` : "";
  return season || episode ? `${season}${episode}` : null;
}

/** The show an episode row belongs to; its own title only when the row names no show. */
export function seriesTitleOf(item: { title?: string | null; parentTitle?: string | null }): string {
  return nonEmpty(item.parentTitle) ?? nonEmpty(item.title) ?? "Unknown";
}

/**
 * One episode, as "<Show> SxxExx". An episode the server never numbered (a
 * special, a date-based show) has only its own title left to tell it apart, so
 * that follows the show instead: "<Show> — <Episode>".
 */
export function formatEpisodeTitle(item: EpisodeTitleParts): string {
  const show = nonEmpty(item.parentTitle);
  const episode = nonEmpty(item.title);
  const code = formatEpisodeCode(item.seasonNumber, item.episodeNumber);
  if (show) {
    if (code) return `${show} ${code}`;
    return episode && episode !== show ? `${show} — ${episode}` : show;
  }
  if (episode) return code ? `${episode} (${code})` : episode;
  return code ?? "Unknown";
}

/** Any `MediaItem` row: an episode by its show and SxxExx, a movie or track by its own title. */
export function formatMediaItemTitle(item: MediaTitleParts): string {
  if (item.type === "SERIES") return formatEpisodeTitle(item);
  return nonEmpty(item.title) ?? "Unknown";
}
