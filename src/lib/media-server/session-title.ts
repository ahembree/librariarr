import type { MediaSession } from "./types";

/**
 * The fields a media title can be built from. Structural rather than
 * `MediaSession` so a caller holding a trimmed session shape (the sessions API
 * response, a log record) can format the same string.
 */
export type SessionTitleParts = Pick<MediaSession, "title" | "type"> &
  Partial<Pick<MediaSession, "parentTitle" | "grandparentTitle" | "year">>;

const SEPARATOR = " · ";

/**
 * A single human-readable media title for a playing session.
 *
 * An episode's `title` is the episode name and a track's is the track name, so
 * either alone is meaningless in a log line ("Pilot" terminated on which show?).
 * Mirrors `formatMediaTitle` on the Stream Manager page so the log names the
 * media the same way the UI the operator acted in did.
 */
export function formatSessionMediaTitle(session: SessionTitleParts): string {
  const title = session.title || "Unknown";

  if (session.type === "episode") {
    const show = session.grandparentTitle || session.parentTitle;
    return show ? `${show}${SEPARATOR}${title}` : title;
  }

  if (session.type === "track") {
    const parts = [session.grandparentTitle, session.parentTitle, title].filter(Boolean);
    return parts.join(SEPARATOR);
  }

  return session.year ? `${title} (${session.year})` : title;
}
