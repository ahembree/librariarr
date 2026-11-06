/**
 * Centralized media-type chip colors and labels.
 *
 * Single source of truth for the "Movie" / "Series" / "Music" chips shown
 * across the app — Watch History, Query Builder, Rule Matches, and Pending
 * Actions — so a media-type chip reads the same everywhere. Uses the
 * `media-*` tokens in globals.css: Movie the sky blue, Series purple, Music
 * the green — the chips' original colours.
 */

/** Tailwind classes (background + text + border) for each media type's chip. */
export const MEDIA_TYPE_BADGE_COLORS: Record<string, string> = {
  MOVIE: "bg-media-movie/20 text-media-movie border-media-movie/30",
  SERIES: "bg-media-series/20 text-media-series border-media-series/30",
  MUSIC: "bg-media-music/20 text-media-music border-media-music/30",
};

/** Singular display label for each media type. */
export const MEDIA_TYPE_LABELS: Record<string, string> = {
  MOVIE: "Movie",
  SERIES: "Series",
  MUSIC: "Music",
};

/** Singular label for a media type, falling back to the raw value. */
export function mediaTypeLabel(type: string): string {
  return MEDIA_TYPE_LABELS[type] ?? type;
}
