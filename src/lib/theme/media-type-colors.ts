/**
 * Centralized media-type chip colors and labels.
 *
 * Single source of truth for the "Movie" / "Series" / "Music" chips shown
 * across the app — Watch History, Query Builder, Rule Matches, and Pending
 * Actions — so a media-type chip reads the same everywhere. Uses the shared
 * design tokens (sky / green) plus Tailwind purple so the chips track the theme.
 */

/** Tailwind classes (background + text + border) for each media type's chip. */
export const MEDIA_TYPE_BADGE_COLORS: Record<string, string> = {
  MOVIE: "bg-sky/20 text-sky border-sky/30",
  SERIES: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  MUSIC: "bg-green/20 text-green border-green/30",
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
