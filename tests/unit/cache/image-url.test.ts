import { describe, it, expect } from "vitest";
import {
  ALL_CACHE_WIDTHS,
  CACHE_WIDTH_ART,
  CACHE_WIDTH_DEFAULT,
  CACHE_WIDTH_GRID,
  CACHE_WIDTH_GRID_WIDE,
  REQUESTABLE_CACHE_WIDTHS,
  parseImageWidth,
  withImageWidth,
} from "@/lib/image-url";

describe("parseImageWidth", () => {
  it("accepts each requestable width", () => {
    for (const width of REQUESTABLE_CACHE_WIDTHS) {
      expect(parseImageWidth(String(width))).toBe(width);
    }
  });

  it("rejects a width that is not on the allow-list", () => {
    // Each accepted width is a separate cached file, so an arbitrary value
    // would let a caller fill the cache with one-off sizes.
    expect(parseImageWidth("401")).toBeNull();
    expect(parseImageWidth("1")).toBeNull();
    expect(parseImageWidth("99999")).toBeNull();
  });

  it("rejects the art width — that is chosen by type=art, not by the caller", () => {
    expect(parseImageWidth(String(CACHE_WIDTH_ART))).toBeNull();
  });

  it("returns null for missing or malformed values", () => {
    expect(parseImageWidth(null)).toBeNull();
    expect(parseImageWidth(undefined)).toBeNull();
    expect(parseImageWidth("")).toBeNull();
    expect(parseImageWidth("abc")).toBeNull();
    expect(parseImageWidth("400px")).toBeNull();
    expect(parseImageWidth("-400")).toBeNull();
  });

  it("covers every requestable width in the purge list", () => {
    // A width that can be written but not invalidated would serve stale
    // artwork until the TTL expired.
    for (const width of [...REQUESTABLE_CACHE_WIDTHS, CACHE_WIDTH_ART]) {
      expect(ALL_CACHE_WIDTHS).toContain(width);
    }
  });
});

describe("withImageWidth", () => {
  it("appends the width to a bare proxy URL", () => {
    expect(withImageWidth("/api/media/abc/image", CACHE_WIDTH_GRID)).toBe(
      "/api/media/abc/image?w=400",
    );
  });

  it("appends to a URL that already carries a query string", () => {
    expect(withImageWidth("/api/media/abc/image?type=parent", CACHE_WIDTH_GRID_WIDE)).toBe(
      "/api/media/abc/image?type=parent&w=640",
    );
  });

  it("leaves an explicit width alone", () => {
    expect(withImageWidth("/api/media/abc/image?w=800", CACHE_WIDTH_GRID)).toBe(
      "/api/media/abc/image?w=800",
    );
    expect(withImageWidth("/api/media/abc/image?type=art&w=800", CACHE_WIDTH_GRID)).toBe(
      "/api/media/abc/image?type=art&w=800",
    );
  });

  it("leaves non-proxy URLs untouched", () => {
    expect(withImageWidth("https://example.com/poster.jpg", CACHE_WIDTH_GRID)).toBe(
      "https://example.com/poster.jpg",
    );
    expect(withImageWidth("/static/fallback.png", CACHE_WIDTH_GRID)).toBe("/static/fallback.png");
  });

  it("does not mistake a query key ending in w for the width param", () => {
    expect(withImageWidth("/api/media/abc/image?draw=1", CACHE_WIDTH_GRID)).toBe(
      "/api/media/abc/image?draw=1&w=400",
    );
  });

  it("keeps grid widths below the default so cards fetch less", () => {
    expect(CACHE_WIDTH_GRID).toBeLessThan(CACHE_WIDTH_DEFAULT);
    expect(CACHE_WIDTH_GRID_WIDE).toBeLessThan(CACHE_WIDTH_DEFAULT);
  });
});
