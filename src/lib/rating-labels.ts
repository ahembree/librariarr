const IMAGE_TO_SOURCE: [RegExp, string][] = [
  [/^rottentomatoes:\/\//, "RT"],
  [/^imdb:\/\//, "IMDb"],
  [/^themoviedb:\/\//, "TMDB"],
  [/^metacritic:\/\//, "Metacritic"],
];

const FIELD_SUFFIX: Record<string, string> = {
  rating: "Critics",
  audienceRating: "Audience",
};

const JELLYFIN_EMBY_DEFAULTS: Record<string, string> = {
  rating: "TMDB",
  audienceRating: "RT Audience",
};

/**
 * Derives a human-readable rating source label.
 *
 * @param ratingImage - The `ratingImage` or `audienceRatingImage` string from the DB (Plex-only)
 * @param serverType - The media server type ("PLEX", "JELLYFIN", "EMBY")
 * @param field - Which rating field this is for ("rating" or "audienceRating") — used for Jellyfin/Emby defaults
 * @param fallback - Fallback label if source can't be determined
 */
export function getRatingLabel(
  ratingImage: string | null | undefined,
  serverType: string | null | undefined,
  field: "rating" | "audienceRating",
  fallback: string,
): string {
  // If we have a ratingImage string (Plex), parse the source and append type
  if (ratingImage) {
    for (const [pattern, source] of IMAGE_TO_SOURCE) {
      if (pattern.test(ratingImage)) {
        const suffix = FIELD_SUFFIX[field];
        return suffix ? `${source} ${suffix}` : source;
      }
    }
  }

  // Jellyfin/Emby don't populate ratingImage — use known defaults
  if (serverType === "JELLYFIN" || serverType === "EMBY") {
    return JELLYFIN_EMBY_DEFAULTS[field] ?? fallback;
  }

  return fallback;
}
