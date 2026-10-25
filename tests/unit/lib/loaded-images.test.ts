import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetLoadedImages,
  firstLoadedImage,
  markImageLoaded,
  posterPlaceholderFor,
  wasImageLoaded,
} from "@/lib/loaded-images";
import { CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE } from "@/lib/image-url";

beforeEach(() => __resetLoadedImages());

describe("loaded images", () => {
  it("remembers what was loaded, and ignores an empty src", () => {
    markImageLoaded("/api/media/a/image?w=400");
    markImageLoaded(null);
    markImageLoaded("");
    expect(wasImageLoaded("/api/media/a/image?w=400")).toBe(true);
    expect(wasImageLoaded("/api/media/b/image?w=400")).toBe(false);
    expect(firstLoadedImage(["/x", "/api/media/a/image?w=400"])).toBe("/api/media/a/image?w=400");
    expect(firstLoadedImage(["/x"])).toBeNull();
  });

  it("offers the grid card's poster under a detail poster only once it was loaded", () => {
    expect(posterPlaceholderFor("/api/media/a/image")).toBeNull();
    markImageLoaded(`/api/media/a/image?w=${CACHE_WIDTH_GRID}`);
    expect(posterPlaceholderFor("/api/media/a/image")).toBe(`/api/media/a/image?w=${CACHE_WIDTH_GRID}`);
  });

  it("finds the landscape card variant and keeps a query string", () => {
    markImageLoaded(`/api/media/e/image?type=parent&w=${CACHE_WIDTH_GRID_WIDE}`);
    expect(posterPlaceholderFor("/api/media/e/image?type=parent")).toBe(
      `/api/media/e/image?type=parent&w=${CACHE_WIDTH_GRID_WIDE}`,
    );
  });

  it("offers nothing for a URL that already names its width", () => {
    markImageLoaded(`/api/media/a/image?w=${CACHE_WIDTH_GRID}`);
    expect(posterPlaceholderFor(`/api/media/a/image?w=${CACHE_WIDTH_GRID}`)).toBeNull();
  });

  it("forgets the oldest URLs past its bound", () => {
    markImageLoaded("/first");
    for (let i = 0; i < 5000; i++) markImageLoaded(`/n${i}`);
    expect(wasImageLoaded("/first")).toBe(false);
    expect(wasImageLoaded("/n4999")).toBe(true);
  });
});
