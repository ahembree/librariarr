import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MEDIA_TYPE_BADGE_COLORS,
  MEDIA_TYPE_LABELS,
  mediaTypeLabel,
} from "@/lib/theme/media-type-colors";

describe("media-type colors", () => {
  it("defines a badge color for every media type", () => {
    expect(MEDIA_TYPE_BADGE_COLORS.MOVIE).toBe("bg-media-movie/20 text-media-movie border-media-movie/30");
    expect(MEDIA_TYPE_BADGE_COLORS.SERIES).toBe("bg-media-series/20 text-media-series border-media-series/30");
    expect(MEDIA_TYPE_BADGE_COLORS.MUSIC).toBe("bg-media-music/20 text-media-music border-media-music/30");
  });

  // The original colours: Movie the sky blue, Series purple, Music the green.
  it("keeps the type chips' original colours", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain("--media-movie: var(--sky);");
    expect(css).toContain("--media-series: oklch(71.4% 0.203 305.504);");
    expect(css).toContain("--media-music: var(--green);");
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
