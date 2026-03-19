import { describe, it, expect } from "vitest";
import { normalizeTitle, computeDedupKey } from "@/lib/dedup/compute-dedup-key";

describe("normalizeTitle", () => {
  it("lowercases input", () => {
    expect(normalizeTitle("Hello World")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeTitle("  foo  ")).toBe("foo");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalizeTitle("hello   world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });

  it("handles single word", () => {
    expect(normalizeTitle("Test")).toBe("test");
  });

  it("collapses all whitespace types", () => {
    expect(normalizeTitle("\t hello \n world ")).toBe("hello world");
  });

  it("preserves unicode characters", () => {
    expect(normalizeTitle("Café Résumé")).toBe("café résumé");
  });

  it("preserves special characters", () => {
    expect(normalizeTitle("Movie: The 2nd!")).toBe("movie: the 2nd!");
  });
});

describe("computeDedupKey", () => {
  describe("MOVIE type", () => {
    it("prioritizes TMDB ID", () => {
      expect(
        computeDedupKey("MOVIE", "The Matrix", {
          externalIds: [
            { source: "tmdb", id: "603" },
            { source: "imdb", id: "tt0133093" },
          ],
        })
      ).toBe("movie:tmdb:603");
    });

    it("falls back to IMDB when no TMDB", () => {
      expect(
        computeDedupKey("MOVIE", "The Matrix", {
          externalIds: [{ source: "imdb", id: "tt0133093" }],
        })
      ).toBe("movie:imdb:tt0133093");
    });

    it("falls back to title+year when no external IDs", () => {
      expect(
        computeDedupKey("MOVIE", "The Matrix", { year: 1999 })
      ).toBe("movie:title:the matrix:1999");
    });

    it("handles null year in fallback", () => {
      expect(
        computeDedupKey("MOVIE", "The Matrix", { year: null })
      ).toBe("movie:title:the matrix:");
    });

    it("handles no options at all", () => {
      expect(computeDedupKey("MOVIE", "The Matrix")).toBe(
        "movie:title:the matrix:"
      );
    });

    it("handles empty externalIds array", () => {
      expect(
        computeDedupKey("MOVIE", "The Matrix", { year: 2020, externalIds: [] })
      ).toBe("movie:title:the matrix:2020");
    });

    it("is case-insensitive for source matching", () => {
      expect(
        computeDedupKey("MOVIE", "Test", {
          externalIds: [{ source: "TMDB", id: "123" }],
        })
      ).toBe("movie:tmdb:123");
    });

    it("normalizes title in fallback key", () => {
      expect(
        computeDedupKey("MOVIE", "  The  Matrix  ", { year: 1999 })
      ).toBe("movie:title:the matrix:1999");
    });
  });

  describe("SERIES type", () => {
    it("uses TVDB if available", () => {
      expect(
        computeDedupKey("SERIES", "Episode 1", {
          externalIds: [{ source: "tvdb", id: "456" }],
          seasonNumber: 1,
          episodeNumber: 3,
        })
      ).toBe("series:tvdb:456:s1e3");
    });

    it("falls back to parentTitle when no TVDB", () => {
      expect(
        computeDedupKey("SERIES", "Episode 1", {
          parentTitle: "Breaking Bad",
          seasonNumber: 2,
          episodeNumber: 5,
        })
      ).toBe("series:breaking bad:s2e5");
    });

    it("falls back to title when no parentTitle and no TVDB", () => {
      expect(
        computeDedupKey("SERIES", "The Pilot", {
          seasonNumber: 1,
          episodeNumber: 1,
        })
      ).toBe("series:the pilot:s1e1");
    });

    it("defaults null season and episode to 0", () => {
      expect(
        computeDedupKey("SERIES", "Special", {
          parentTitle: "Show",
          seasonNumber: null,
          episodeNumber: null,
        })
      ).toBe("series:show:s0e0");
    });

    it("handles missing season/episode in opts", () => {
      expect(
        computeDedupKey("SERIES", "Episode", { parentTitle: "Show" })
      ).toBe("series:show:s0e0");
    });

    it("is case-insensitive for TVDB source", () => {
      expect(
        computeDedupKey("SERIES", "Ep", {
          externalIds: [{ source: "TVDB", id: "999" }],
          seasonNumber: 3,
          episodeNumber: 7,
        })
      ).toBe("series:tvdb:999:s3e7");
    });
  });

  describe("MUSIC type", () => {
    it("uses parentTitle as artist + title as track", () => {
      expect(
        computeDedupKey("MUSIC", "Bohemian Rhapsody", {
          parentTitle: "Queen",
        })
      ).toBe("music:queen:bohemian rhapsody");
    });

    it("defaults parentTitle to 'unknown' when null", () => {
      expect(
        computeDedupKey("MUSIC", "Some Track", { parentTitle: null })
      ).toBe("music:unknown:some track");
    });

    it("defaults parentTitle to 'unknown' when not provided", () => {
      expect(computeDedupKey("MUSIC", "Some Track")).toBe(
        "music:unknown:some track"
      );
    });

    it("normalizes both components", () => {
      expect(
        computeDedupKey("MUSIC", "  Track  Name  ", {
          parentTitle: "  Artist  Name  ",
        })
      ).toBe("music:artist name:track name");
    });
  });

  describe("unknown type fallback", () => {
    it("returns title-based key for unrecognized type", () => {
      // Cast to bypass TypeScript type checking for this edge case test
      expect(
        computeDedupKey("OTHER" as "MOVIE", "Something", { year: 2020 })
      ).toBe("title:something:2020");
    });

    it("handles null year in unknown type", () => {
      expect(
        computeDedupKey("UNKNOWN" as "MOVIE", "Item", { year: null })
      ).toBe("title:item:");
    });
  });
});
