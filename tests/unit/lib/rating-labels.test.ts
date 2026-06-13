import { describe, it, expect } from "vitest";
import { getRatingLabel } from "@/lib/rating-labels";

describe("getRatingLabel", () => {
  describe("Plex ratingImage parsing", () => {
    it("parses rottentomatoes image as RT with critics suffix for rating field", () => {
      expect(
        getRatingLabel("rottentomatoes://image.rt.fresh", "PLEX", "rating", "fallback"),
      ).toBe("RT Critics");
    });

    it("parses rottentomatoes image as RT with audience suffix for audienceRating field", () => {
      expect(
        getRatingLabel("rottentomatoes://image.rt.upright", "PLEX", "audienceRating", "fallback"),
      ).toBe("RT Audience");
    });

    it("parses imdb image as IMDb", () => {
      expect(getRatingLabel("imdb://image.rating", "PLEX", "rating", "fallback")).toBe(
        "IMDb Critics",
      );
    });

    it("parses themoviedb image as TMDB", () => {
      expect(
        getRatingLabel("themoviedb://image.rating", "PLEX", "audienceRating", "fallback"),
      ).toBe("TMDB Audience");
    });

    it("parses metacritic image as Metacritic", () => {
      expect(
        getRatingLabel("metacritic://image.rating", "PLEX", "rating", "fallback"),
      ).toBe("Metacritic Critics");
    });

    it("matches the first pattern when image starts with that prefix", () => {
      // The regex is anchored at the start (^), so only a prefix match counts.
      expect(getRatingLabel("imdb://something", "PLEX", "audienceRating", "fb")).toBe(
        "IMDb Audience",
      );
    });

    it("falls through to fallback when ratingImage doesn't match any known source (Plex)", () => {
      expect(
        getRatingLabel("unknownsource://image", "PLEX", "rating", "myFallback"),
      ).toBe("myFallback");
    });

    it("does not match when the source prefix is not at the start", () => {
      // "://imdb" embedded mid-string should NOT match because the regex is anchored.
      expect(
        getRatingLabel("prefix-imdb://image", "PLEX", "rating", "fallbackX"),
      ).toBe("fallbackX");
    });
  });

  describe("Jellyfin/Emby defaults", () => {
    it("returns TMDB default for JELLYFIN rating field with no ratingImage", () => {
      expect(getRatingLabel(null, "JELLYFIN", "rating", "fallback")).toBe("TMDB");
    });

    it("returns RT Audience default for JELLYFIN audienceRating field with no ratingImage", () => {
      expect(getRatingLabel(null, "JELLYFIN", "audienceRating", "fallback")).toBe(
        "RT Audience",
      );
    });

    it("returns TMDB default for EMBY rating field with no ratingImage", () => {
      expect(getRatingLabel(undefined, "EMBY", "rating", "fallback")).toBe("TMDB");
    });

    it("returns RT Audience default for EMBY audienceRating field with no ratingImage", () => {
      expect(getRatingLabel("", "EMBY", "audienceRating", "fallback")).toBe("RT Audience");
    });

    it("uses Jellyfin/Emby defaults even when an empty-string ratingImage is passed", () => {
      // Empty string is falsy, so the ratingImage branch is skipped.
      expect(getRatingLabel("", "JELLYFIN", "rating", "fallback")).toBe("TMDB");
    });
  });

  describe("fallback behavior", () => {
    it("returns fallback when serverType is PLEX with no ratingImage", () => {
      expect(getRatingLabel(null, "PLEX", "rating", "fb")).toBe("fb");
    });

    it("returns fallback when serverType is null", () => {
      expect(getRatingLabel(null, null, "rating", "fb")).toBe("fb");
    });

    it("returns fallback when serverType is undefined", () => {
      expect(getRatingLabel(undefined, undefined, "audienceRating", "fb")).toBe("fb");
    });

    it("returns fallback for an unknown serverType with no ratingImage", () => {
      expect(getRatingLabel(null, "SOMETHING_ELSE", "rating", "the-fallback")).toBe(
        "the-fallback",
      );
    });

    it("prefers ratingImage parsing over server-type defaults", () => {
      // Even though server is JELLYFIN, a present ratingImage wins.
      expect(getRatingLabel("imdb://x", "JELLYFIN", "rating", "fb")).toBe("IMDb Critics");
    });
  });
});
