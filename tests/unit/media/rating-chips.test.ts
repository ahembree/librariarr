import { describe, it, expect } from "vitest";
import { ratingChipsOf } from "@/lib/media/rating-chips";

const labels = (chips: ReturnType<typeof ratingChipsOf>) => chips.map((c) => `${c.label} ${c.value}`);

describe("ratingChipsOf", () => {
  const scores = { imdbRating: 7.4, tmdbRating: 7.5, rtCriticRating: 9.4, rtAudienceRating: 9.2 };

  it("lists each provider's score, then a server rating from another source, then the user's", () => {
    expect(labels(ratingChipsOf({ ...scores, rating: 6, ratingImage: "metacritic://image.rating", userRating: 8 }, "PLEX")))
      .toEqual(["IMDb 7.4", "RT Critics 9.4", "RT Audience 9.2", "TMDB 7.5", "Metacritic Critics 6", "You 8"]);
  });

  it("drops a server rating that repeats a provider's score, whatever the image's case", () => {
    const chips = ratingChipsOf({
      ...scores,
      rating: 9.4, ratingImage: "RottenTomatoes://image.rating.ripe",
      audienceRating: 7.5, audienceRatingImage: "themoviedb://image.rating",
    }, "PLEX");
    expect(labels(chips)).toEqual(["IMDb 7.4", "RT Critics 9.4", "RT Audience 9.2", "TMDB 7.5"]);
  });

  it("keeps the server's ratings, labelled by source, when there are no provider scores", () => {
    expect(labels(ratingChipsOf({ rating: 9.4, ratingImage: "rottentomatoes://image.rating.ripe", audienceRating: 7 }, "PLEX")))
      .toEqual(["RT Critics 9.4", "Audience 7"]);
    expect(labels(ratingChipsOf({ rating: 7.1, audienceRating: 8 }, "JELLYFIN"))).toEqual(["TMDB 7.1", "RT Audience 8"]);
  });

  it("leaves the provider scores out when asked, and keeps the server's ratings then", () => {
    expect(labels(ratingChipsOf({ ...scores, rating: 9.4, ratingImage: "rottentomatoes://image.rating.ripe" }, "PLEX", { providers: false })))
      .toEqual(["RT Critics 9.4"]);
  });

  it("lists nothing for an unrated item", () => {
    expect(ratingChipsOf({ imdbRating: null, rating: null }, "PLEX")).toEqual([]);
  });
});
