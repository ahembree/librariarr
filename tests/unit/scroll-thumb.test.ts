import { describe, it, expect } from "vitest";
import { horizontalThumb, scrollPerThumbPixel, MIN_THUMB_WIDTH } from "@/lib/scroll-thumb";

describe("horizontalThumb", () => {
  it("sizes the thumb to the visible share of the table and places it by scroll position", () => {
    // 1,000 visible of 2,000 in a 500px track: half-width thumb.
    expect(horizontalThumb(0, 2000, 1000, 500)).toEqual({ width: 250, left: 0 });
    expect(horizontalThumb(500, 2000, 1000, 500)).toEqual({ width: 250, left: 125 });
    expect(horizontalThumb(1000, 2000, 1000, 500)).toEqual({ width: 250, left: 250 });
  });

  it("keeps a very wide table's thumb grabbable", () => {
    expect(horizontalThumb(0, 100_000, 1000, 500).width).toBe(MIN_THUMB_WIDTH);
    expect(horizontalThumb(99_000, 100_000, 1000, 500).left).toBe(500 - MIN_THUMB_WIDTH);
  });

  it("clamps an overscrolled position and fills the track when nothing overflows", () => {
    expect(horizontalThumb(5000, 2000, 1000, 500).left).toBe(250);
    expect(horizontalThumb(-20, 2000, 1000, 500).left).toBe(0);
    expect(horizontalThumb(0, 900, 1000, 500)).toEqual({ width: 500, left: 0 });
  });
});

describe("scrollPerThumbPixel", () => {
  it("maps the thumb's travel onto the table's scroll range", () => {
    // Thumb travels 250px for 1,000px of scroll.
    expect(scrollPerThumbPixel(2000, 1000, 500, 250)).toBe(4);
    expect(scrollPerThumbPixel(2000, 1000, 500, 500)).toBe(0);
  });
});
