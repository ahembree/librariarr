import { describe, it, expect } from "vitest";
import { extractExternalRatings } from "@/lib/media/external-ratings";

const EMPTY = { imdbRating: null, tmdbRating: null, rtCriticRating: null, rtAudienceRating: null };

describe("extractExternalRatings", () => {
  it("reads every provider from Plex's Rating array, all on Plex's 0–10 scale", () => {
    expect(extractExternalRatings({
      audienceRating: 7.5,
      audienceRatingImage: "themoviedb://image.rating",
      Rating: [
        { image: "imdb://image.rating", value: 7.4, type: "audience" },
        { image: "rottentomatoes://image.rating.ripe", value: 9.4, type: "critic" },
        { image: "rottentomatoes://image.rating.upright", value: 9.2, type: "audience" },
        { image: "themoviedb://image.rating", value: 7.5, type: "audience" },
      ],
    })).toEqual({ imdbRating: 7.4, tmdbRating: 7.5, rtCriticRating: 9.4, rtAudienceRating: 9.2 });
  });

  it("tells the Rotten Tomatoes scores apart by icon, then by type", () => {
    expect(extractExternalRatings({
      Rating: [
        { image: "rottentomatoes://image.rating.rotten", value: 3.1, type: "audience" },
        { image: "rottentomatoes://image.rating.spilled", value: 4.4, type: "critic" },
      ],
    })).toMatchObject({ rtCriticRating: 3.1, rtAudienceRating: 4.4 });
    expect(extractExternalRatings({
      Rating: [
        { image: "rottentomatoes://image.rating.other", value: 8, type: "critic" },
        { image: "rottentomatoes://image.rating.other", value: 7, type: "audience" },
      ],
    })).toMatchObject({ rtCriticRating: 8, rtAudienceRating: 7 });
  });

  it("falls back to rating/audienceRating by their images when the array lacks a provider", () => {
    expect(extractExternalRatings({
      rating: 9.4,
      ratingImage: "rottentomatoes://image.rating.ripe",
      audienceRating: 9.2,
      audienceRatingImage: "rottentomatoes://image.rating.upright",
    })).toEqual({ ...EMPTY, rtCriticRating: 9.4, rtAudienceRating: 9.2 });
    expect(extractExternalRatings({
      audienceRating: 7.4,
      audienceRatingImage: "imdb://image.rating",
      Rating: [{ image: "themoviedb://image.rating", value: 7.5, type: "audience" }],
    })).toEqual({ ...EMPTY, imdbRating: 7.4, tmdbRating: 7.5 });
  });

  it("prefers the array over the fallback fields", () => {
    expect(extractExternalRatings({
      audienceRating: 6,
      audienceRatingImage: "imdb://image.rating",
      Rating: [{ image: "imdb://image.rating", value: 7.4, type: "audience" }],
    }).imdbRating).toBe(7.4);
  });

  it("ignores unknown providers, missing or non-numeric values and an absent array", () => {
    expect(extractExternalRatings({
      rating: 8,
      Rating: [
        { image: "metacritic://image.rating", value: 8, type: "critic" },
        { image: "imdb://image.rating", value: null, type: "audience" },
        { image: "themoviedb://image.rating", value: "n/a", type: "audience" },
        { image: null, value: 5, type: "critic" },
      ],
    })).toEqual(EMPTY);
    expect(extractExternalRatings({})).toEqual(EMPTY);
  });

  it("reads a numeric string value", () => {
    expect(extractExternalRatings({ Rating: [{ image: "imdb://image.rating", value: "7.4", type: "audience" }] }).imdbRating).toBe(7.4);
  });
});
