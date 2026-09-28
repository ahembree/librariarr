import { formatEpisodeTitle } from "@/lib/media/display-title";
import type { MediaSession } from "./types";

/**
 * Structural rather than `MediaSession` so a caller holding a trimmed session
 * shape (the sessions API response) can format the same string.
 */
export type SessionTitleParts = Pick<MediaSession, "title" | "type"> &
  Partial<
    Pick<MediaSession, "parentTitle" | "grandparentTitle" | "year" | "seasonNumber" | "episodeNumber">
  >;

const SEPARATOR = " · ";

/**
 * A single human-readable media title for a playing session.
 *
 * An episode's `title` is the episode name and a track's is the track name, so
 * either alone is meaningless ("Pilot" — of which show?). An episode is named by
 * its show and SxxExx ("Breaking Bad S01E01"); the show is `grandparentTitle`
 * alone, since an episode's `parentTitle` is its SEASON ("Season 1").
 */
export function formatSessionMediaTitle(session: SessionTitleParts): string {
  const title = session.title || "Unknown";

  if (session.type === "episode") {
    return formatEpisodeTitle({
      title: session.title,
      parentTitle: session.grandparentTitle,
      seasonNumber: session.seasonNumber,
      episodeNumber: session.episodeNumber,
    });
  }

  if (session.type === "track") {
    const parts = [session.grandparentTitle, session.parentTitle, title].filter(Boolean);
    return parts.join(SEPARATOR);
  }

  return session.year ? `${title} (${session.year})` : title;
}
