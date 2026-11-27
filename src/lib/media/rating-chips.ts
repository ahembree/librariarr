/**
 * The rating chips an item shows, in order — the one list the detail pages,
 * the hover popover and the Stream Manager's session sheet all draw, so the
 * per-provider ratings appear wherever the critic and audience ratings do.
 * Client-safe.
 *
 *  1. Plex's per-provider scores: IMDb, Rotten Tomatoes critics and audience,
 *     TMDB (`imdbRating`, `rtCriticRating`, `rtAudienceRating`, `tmdbRating`).
 *  2. The server's critic and audience ratings (`rating`, `audienceRating`),
 *     labelled by their source — left out when the item has per-provider
 *     scores and the rating's own source is one of them (the same score twice).
 *  3. The user's own rating.
 *
 * `providers: false` leaves the per-provider scores out: a show's or season's
 * record is one of its episodes, whose scores are that episode's, not the show's.
 */
import { getRatingLabel } from "@/lib/rating-labels";

export interface RatedValues {
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  userRating?: number | null;
  imdbRating?: number | null;
  tmdbRating?: number | null;
  rtCriticRating?: number | null;
  rtAudienceRating?: number | null;
}

export interface RatingChipSpec {
  key: string;
  label: string;
  value: number;
}

/** A Plex rating image naming a provider stored in its own column. */
const PROVIDER_IMAGE = /^(imdb|themoviedb|rottentomatoes):\/\//i;

const PROVIDER_CHIPS: ReadonlyArray<[keyof RatedValues, string]> = [
  ["imdbRating", "IMDb"],
  ["rtCriticRating", "RT Critics"],
  ["rtAudienceRating", "RT Audience"],
  ["tmdbRating", "TMDB"],
];

export function ratingChipsOf(
  item: RatedValues,
  serverType: string | null | undefined,
  options: { providers?: boolean } = {},
): RatingChipSpec[] {
  const providers = options.providers ?? true;
  const chips: RatingChipSpec[] = [];
  let hasProviders = false;
  if (providers) {
    for (const [key, label] of PROVIDER_CHIPS) {
      const value = item[key];
      if (typeof value === "number") {
        chips.push({ key, label, value });
        hasProviders = true;
      }
    }
  }
  const showServerRating = (image: string | null | undefined) =>
    !hasProviders || !image || !PROVIDER_IMAGE.test(image);
  if (item.rating != null && showServerRating(item.ratingImage)) {
    chips.push({ key: "rating", label: getRatingLabel(item.ratingImage, serverType, "rating", "Critic"), value: item.rating });
  }
  if (item.audienceRating != null && showServerRating(item.audienceRatingImage)) {
    chips.push({
      key: "audienceRating",
      label: getRatingLabel(item.audienceRatingImage, serverType, "audienceRating", "Audience"),
      value: item.audienceRating,
    });
  }
  if (item.userRating != null) chips.push({ key: "userRating", label: "You", value: item.userRating });
  return chips;
}
