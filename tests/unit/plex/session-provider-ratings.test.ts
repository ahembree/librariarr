import { describe, it, expect } from "vitest";
import { sessionProviderRatings } from "@/lib/plex/client";

describe("sessionProviderRatings", () => {
  it("reads a session item's Rating array as the sync does", () => {
    expect(sessionProviderRatings({
      Rating: [
        { image: "imdb://image.rating", value: 7.4, type: "audience" },
        { image: "rottentomatoes://image.rating.ripe", value: 9.4, type: "critic" },
      ],
    })).toEqual({ imdbRating: 7.4, tmdbRating: undefined, rtCriticRating: 9.4, rtAudienceRating: undefined });
  });

  it("falls back to the library source's two ratings, and gives nothing for an unrated item", () => {
    expect(sessionProviderRatings({ audienceRating: 7.5, audienceRatingImage: "themoviedb://image.rating" }))
      .toMatchObject({ tmdbRating: 7.5 });
    expect(sessionProviderRatings({})).toEqual({
      imdbRating: undefined, tmdbRating: undefined, rtCriticRating: undefined, rtAudienceRating: undefined,
    });
  });
});
