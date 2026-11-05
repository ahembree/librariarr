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

  // A type is identity, not status: a Music chip must not read as "success".
  it("never borrows a status colour", () => {
    for (const classes of Object.values(MEDIA_TYPE_BADGE_COLORS)) {
      expect(classes).not.toMatch(/\b(bg|text|border)-(green|amber|red|sky)\b/);
    }
  });

  // Movie and Series once sat 28 degrees apart (indigo beside purple) and read
  // as one colour. Measured in OKLab, the perceptual space OKLCH is built on.
  it("keeps the three type colours apart, and apart from every status colour", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    const token = (name: string): [number, number, number] => {
      const m = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)(%?)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(css);
      if (!m) throw new Error(`--${name} not found`);
      const l = Number(m[1]) / (m[2] ? 100 : 1);
      const c = Number(m[3]);
      const h = (Number(m[4]) * Math.PI) / 180;
      return [l, c * Math.cos(h), c * Math.sin(h)];
    };
    const distance = (a: [number, number, number], b: [number, number, number]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const types = ["media-movie", "media-series", "media-music"].map(token);
    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) expect(distance(types[i], types[j])).toBeGreaterThan(0.2);
    }
    // The dark theme's status values (the .dark block, the shipped theme).
    const status: [number, number, number][] = [
      [0.74, 0.16, 158],
      [0.8, 0.15, 78],
      [0.7, 0.19, 22],
      [0.72, 0.13, 235],
    ].map(([l, c, h]) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)]);
    for (const t of types) for (const s of status) expect(distance(t, s)).toBeGreaterThan(0.1);
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
