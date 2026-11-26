/**
 * Each provider's score for an item, read from Plex's metadata.
 *
 * Plex's `rating` / `audienceRating` hold only the two scores of the library's
 * chosen ratings source (Rotten Tomatoes, IMDb or TMDB). The per-item detail
 * response also carries a `Rating` array with every provider's score, e.g.
 *
 *   { image: "imdb://image.rating",                 value: 7.4, type: "audience" }
 *   { image: "rottentomatoes://image.rating.ripe",  value: 9.4, type: "critic" }
 *   { image: "rottentomatoes://image.rating.upright", value: 9.2, type: "audience" }
 *   { image: "themoviedb://image.rating",           value: 7.5, type: "audience" }
 *
 * IMDb and TMDB are stored on their own 0–10 scale. Rotten Tomatoes is stored
 * as the percentage Plex and Rotten Tomatoes show (Plex sends 9.4 for 94%).
 *
 * The array is read first; a provider it lacks (a bulk-listing item, which
 * carries no array) is filled from `rating`/`ratingImage` and
 * `audienceRating`/`audienceRatingImage`.
 */

export interface ExternalRatings {
  imdbRating: number | null;
  tmdbRating: number | null;
  rtCriticRating: number | null;
  rtAudienceRating: number | null;
}

export interface ExternalRatingsSource {
  Rating?: Array<{ image?: string | null; value?: number | string | null; type?: string | null }> | null;
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
}

type Slot = "critic" | "audience";

function toScore(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Which column a score belongs to, or null for a provider not stored. */
function classify(image: string | null | undefined, slot: Slot | null): keyof ExternalRatings | null {
  if (!image) return null;
  const img = image.toLowerCase();
  if (img.startsWith("imdb://")) return "imdbRating";
  if (img.startsWith("themoviedb://")) return "tmdbRating";
  if (img.startsWith("rottentomatoes://")) {
    // The icon names the score: ripe/rotten tomato for critics, upright/spilled
    // popcorn for the audience. The slot decides when the icon is unfamiliar.
    if (/\.(ripe|rotten)$/.test(img)) return "rtCriticRating";
    if (/\.(upright|spilled)$/.test(img)) return "rtAudienceRating";
    if (slot === "critic") return "rtCriticRating";
    if (slot === "audience") return "rtAudienceRating";
  }
  return null;
}

function scaled(column: keyof ExternalRatings, value: number): number {
  // Rotten Tomatoes is a whole percentage; Plex sends it on a 0–10 scale.
  return column === "rtCriticRating" || column === "rtAudienceRating"
    ? Math.round(value * 10)
    : value;
}

export function extractExternalRatings(item: ExternalRatingsSource): ExternalRatings {
  const out: ExternalRatings = {
    imdbRating: null,
    tmdbRating: null,
    rtCriticRating: null,
    rtAudienceRating: null,
  };

  if (Array.isArray(item.Rating)) {
    for (const entry of item.Rating) {
      if (!entry) continue;
      const value = toScore(entry.value);
      if (value == null) continue;
      const type = entry.type === "critic" || entry.type === "audience" ? entry.type : null;
      const column = classify(entry.image, type);
      if (column && out[column] == null) out[column] = scaled(column, value);
    }
  }

  const fallbacks: Array<[unknown, string | null | undefined, Slot]> = [
    [item.rating, item.ratingImage, "critic"],
    [item.audienceRating, item.audienceRatingImage, "audience"],
  ];
  for (const [raw, image, slot] of fallbacks) {
    const value = toScore(raw);
    if (value == null) continue;
    const column = classify(image, slot);
    if (column && out[column] == null) out[column] = scaled(column, value);
  }

  return out;
}
