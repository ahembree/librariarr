import { describe, it, expect } from "vitest";
import {
  MEDIA_TYPE_BADGE_COLORS,
  MEDIA_TYPE_LABELS,
  mediaTypeLabel,
} from "@/lib/theme/media-type-colors";

describe("media-type colors", () => {
  it("defines a badge color for every media type", () => {
    expect(MEDIA_TYPE_BADGE_COLORS.MOVIE).toBe("bg-sky/20 text-sky border-sky/30");
    expect(MEDIA_TYPE_BADGE_COLORS.SERIES).toBe(
      "bg-purple-500/20 text-purple-400 border-purple-500/30",
    );
    expect(MEDIA_TYPE_BADGE_COLORS.MUSIC).toBe("bg-green/20 text-green border-green/30");
  });

  it("each badge color carries background, text, and border classes", () => {
    for (const classes of Object.values(MEDIA_TYPE_BADGE_COLORS)) {
      expect(classes).toMatch(/\bbg-/);
      expect(classes).toMatch(/\btext-/);
      expect(classes).toMatch(/\bborder-/);
    }
  });

  it("defines a singular label for every media type", () => {
    expect(MEDIA_TYPE_LABELS).toEqual({
      MOVIE: "Movie",
      SERIES: "Series",
      MUSIC: "Music",
    });
  });
});

describe("mediaTypeLabel", () => {
  it("returns the singular label for known types", () => {
    expect(mediaTypeLabel("MOVIE")).toBe("Movie");
    expect(mediaTypeLabel("SERIES")).toBe("Series");
    expect(mediaTypeLabel("MUSIC")).toBe("Music");
  });

  it("falls back to the raw value for unknown types", () => {
    expect(mediaTypeLabel("OTHER")).toBe("OTHER");
    expect(mediaTypeLabel("")).toBe("");
  });
});
