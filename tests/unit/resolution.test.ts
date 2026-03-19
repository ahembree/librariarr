import { describe, it, expect } from "vitest";
import {
  normalizeResolutionLabel,
  normalizeResolutionFromDimensions,
} from "@/lib/resolution";

describe("normalizeResolutionLabel", () => {
  it("returns 'Other' for null", () => {
    expect(normalizeResolutionLabel(null)).toBe("Other");
  });

  it("returns 'Other' for undefined", () => {
    expect(normalizeResolutionLabel(undefined)).toBe("Other");
  });

  it("returns 'Other' for empty string", () => {
    expect(normalizeResolutionLabel("")).toBe("Other");
  });

  // Standard resolution labels
  it("normalizes '4k' to '4K'", () => {
    expect(normalizeResolutionLabel("4k")).toBe("4K");
  });

  it("normalizes '4K' (uppercase) to '4K'", () => {
    expect(normalizeResolutionLabel("4K")).toBe("4K");
  });

  it("normalizes '2160' to '4K'", () => {
    expect(normalizeResolutionLabel("2160")).toBe("4K");
  });

  it("normalizes '2160p' to '4K'", () => {
    expect(normalizeResolutionLabel("2160p")).toBe("4K");
  });

  it("normalizes '2160P' (uppercase P) to '4K'", () => {
    expect(normalizeResolutionLabel("2160P")).toBe("4K");
  });

  it("normalizes '1080' to '1080P'", () => {
    expect(normalizeResolutionLabel("1080")).toBe("1080P");
  });

  it("normalizes '1080p' to '1080P'", () => {
    expect(normalizeResolutionLabel("1080p")).toBe("1080P");
  });

  it("normalizes '1080P' (uppercase) to '1080P'", () => {
    expect(normalizeResolutionLabel("1080P")).toBe("1080P");
  });

  it("normalizes '720' to '720P'", () => {
    expect(normalizeResolutionLabel("720")).toBe("720P");
  });

  it("normalizes '720p' to '720P'", () => {
    expect(normalizeResolutionLabel("720p")).toBe("720P");
  });

  it("normalizes '480' to '480P'", () => {
    expect(normalizeResolutionLabel("480")).toBe("480P");
  });

  it("normalizes '480p' to '480P'", () => {
    expect(normalizeResolutionLabel("480p")).toBe("480P");
  });

  it("normalizes '360' to 'SD'", () => {
    expect(normalizeResolutionLabel("360")).toBe("SD");
  });

  it("normalizes '360p' to 'SD'", () => {
    expect(normalizeResolutionLabel("360p")).toBe("SD");
  });

  it("normalizes 'sd' to 'SD'", () => {
    expect(normalizeResolutionLabel("sd")).toBe("SD");
  });

  it("normalizes 'SD' (uppercase) to 'SD'", () => {
    expect(normalizeResolutionLabel("SD")).toBe("SD");
  });

  // Non-standard numeric resolutions (height-based fallback)
  it("maps height >= 2000 to '4K'", () => {
    expect(normalizeResolutionLabel("2000")).toBe("4K");
    expect(normalizeResolutionLabel("2500")).toBe("4K");
    expect(normalizeResolutionLabel("3000")).toBe("4K");
  });

  it("maps height 900-1999 to '1080P'", () => {
    expect(normalizeResolutionLabel("900")).toBe("1080P");
    expect(normalizeResolutionLabel("1024")).toBe("1080P");
    expect(normalizeResolutionLabel("1999")).toBe("1080P");
  });

  it("maps height 600-899 to '720P'", () => {
    expect(normalizeResolutionLabel("600")).toBe("720P");
    expect(normalizeResolutionLabel("872")).toBe("720P");
    expect(normalizeResolutionLabel("899")).toBe("720P");
  });

  it("maps height 300-599 to '480P'", () => {
    expect(normalizeResolutionLabel("300")).toBe("480P");
    expect(normalizeResolutionLabel("536")).toBe("480P");
    expect(normalizeResolutionLabel("599")).toBe("480P");
  });

  it("maps height < 300 to 'SD'", () => {
    expect(normalizeResolutionLabel("240")).toBe("SD");
    expect(normalizeResolutionLabel("144")).toBe("SD");
    expect(normalizeResolutionLabel("1")).toBe("SD");
  });

  // Non-standard with 'p' suffix
  it("handles non-standard heights with 'p' suffix", () => {
    expect(normalizeResolutionLabel("1024p")).toBe("1080P");
    expect(normalizeResolutionLabel("872p")).toBe("720P");
    expect(normalizeResolutionLabel("536p")).toBe("480P");
  });

  // Non-numeric, non-standard strings
  it("returns 'Other' for non-numeric non-standard strings", () => {
    expect(normalizeResolutionLabel("unknown")).toBe("Other");
    expect(normalizeResolutionLabel("fullhd")).toBe("Other");
    expect(normalizeResolutionLabel("abc")).toBe("Other");
  });
});

describe("normalizeResolutionFromDimensions", () => {
  // No dimensions
  it("returns undefined when neither width nor height is provided", () => {
    expect(normalizeResolutionFromDimensions()).toBeUndefined();
  });

  it("returns undefined when width is 0 and height is 0", () => {
    expect(normalizeResolutionFromDimensions(0, 0)).toBeUndefined();
  });

  it("returns undefined when width is undefined and height is undefined", () => {
    expect(normalizeResolutionFromDimensions(undefined, undefined)).toBeUndefined();
  });

  // Width-based classification
  it("classifies width >= 3000 as '4k'", () => {
    expect(normalizeResolutionFromDimensions(3000)).toBe("4k");
    expect(normalizeResolutionFromDimensions(3840)).toBe("4k");
    expect(normalizeResolutionFromDimensions(4096)).toBe("4k");
  });

  it("classifies width 1600-2999 as '1080'", () => {
    expect(normalizeResolutionFromDimensions(1600)).toBe("1080");
    expect(normalizeResolutionFromDimensions(1920)).toBe("1080");
    expect(normalizeResolutionFromDimensions(2999)).toBe("1080");
  });

  it("classifies width 1000-1599 as '720'", () => {
    expect(normalizeResolutionFromDimensions(1000)).toBe("720");
    expect(normalizeResolutionFromDimensions(1280)).toBe("720");
    expect(normalizeResolutionFromDimensions(1599)).toBe("720");
  });

  it("classifies width 600-999 as '480'", () => {
    expect(normalizeResolutionFromDimensions(600)).toBe("480");
    expect(normalizeResolutionFromDimensions(720)).toBe("480");
    expect(normalizeResolutionFromDimensions(999)).toBe("480");
  });

  it("classifies width < 600 as 'sd'", () => {
    expect(normalizeResolutionFromDimensions(320)).toBe("sd");
    expect(normalizeResolutionFromDimensions(1)).toBe("sd");
    expect(normalizeResolutionFromDimensions(599)).toBe("sd");
  });

  // Height-based fallback (when width is 0 or undefined)
  it("falls back to height when width is 0", () => {
    expect(normalizeResolutionFromDimensions(0, 2160)).toBe("4k");
    expect(normalizeResolutionFromDimensions(0, 1080)).toBe("1080");
    expect(normalizeResolutionFromDimensions(0, 720)).toBe("720");
    expect(normalizeResolutionFromDimensions(0, 480)).toBe("480");
    expect(normalizeResolutionFromDimensions(0, 240)).toBe("sd");
  });

  it("falls back to height when width is undefined", () => {
    expect(normalizeResolutionFromDimensions(undefined, 2160)).toBe("4k");
    expect(normalizeResolutionFromDimensions(undefined, 1080)).toBe("1080");
    expect(normalizeResolutionFromDimensions(undefined, 720)).toBe("720");
    expect(normalizeResolutionFromDimensions(undefined, 480)).toBe("480");
    expect(normalizeResolutionFromDimensions(undefined, 240)).toBe("sd");
  });

  it("classifies height >= 2000 as '4k'", () => {
    expect(normalizeResolutionFromDimensions(undefined, 2000)).toBe("4k");
    expect(normalizeResolutionFromDimensions(undefined, 2160)).toBe("4k");
  });

  it("classifies height 900-1999 as '1080'", () => {
    expect(normalizeResolutionFromDimensions(undefined, 900)).toBe("1080");
    expect(normalizeResolutionFromDimensions(undefined, 1080)).toBe("1080");
    expect(normalizeResolutionFromDimensions(undefined, 1999)).toBe("1080");
  });

  it("classifies height 600-899 as '720'", () => {
    expect(normalizeResolutionFromDimensions(undefined, 600)).toBe("720");
    expect(normalizeResolutionFromDimensions(undefined, 720)).toBe("720");
    expect(normalizeResolutionFromDimensions(undefined, 899)).toBe("720");
  });

  it("classifies height 300-599 as '480'", () => {
    expect(normalizeResolutionFromDimensions(undefined, 300)).toBe("480");
    expect(normalizeResolutionFromDimensions(undefined, 480)).toBe("480");
    expect(normalizeResolutionFromDimensions(undefined, 599)).toBe("480");
  });

  it("classifies height < 300 as 'sd'", () => {
    expect(normalizeResolutionFromDimensions(undefined, 240)).toBe("sd");
    expect(normalizeResolutionFromDimensions(undefined, 144)).toBe("sd");
    expect(normalizeResolutionFromDimensions(undefined, 1)).toBe("sd");
  });

  // Width takes priority over height
  it("uses width over height when both are provided", () => {
    // Width says 1080, height says 720 — width wins
    expect(normalizeResolutionFromDimensions(1920, 720)).toBe("1080");
    // Width says 720, height says 1080 — width wins
    expect(normalizeResolutionFromDimensions(1280, 1080)).toBe("720");
  });

  // Common real-world dimensions
  it("handles common 4K dimensions", () => {
    expect(normalizeResolutionFromDimensions(3840, 2160)).toBe("4k");
    expect(normalizeResolutionFromDimensions(4096, 2160)).toBe("4k");
  });

  it("handles common 1080p dimensions", () => {
    expect(normalizeResolutionFromDimensions(1920, 1080)).toBe("1080");
    expect(normalizeResolutionFromDimensions(1920, 800)).toBe("1080"); // 2.40:1 aspect ratio
  });

  it("handles common 720p dimensions", () => {
    expect(normalizeResolutionFromDimensions(1280, 720)).toBe("720");
  });

  it("handles common 480p dimensions", () => {
    expect(normalizeResolutionFromDimensions(720, 480)).toBe("480");
    expect(normalizeResolutionFromDimensions(640, 480)).toBe("480");
  });

  it("handles common SD dimensions", () => {
    expect(normalizeResolutionFromDimensions(320, 240)).toBe("sd");
  });
});
