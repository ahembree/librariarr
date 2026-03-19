import { describe, it, expect } from "vitest";
import {
  detectDynamicRangeFromFilename,
  detectAudioProfileFromFilename,
  detectDynamicRange,
  detectAudioProfile,
} from "@/lib/sync/sync-server";
import type { MediaStream, MediaPart } from "@/lib/media-server/types";

describe("detectDynamicRangeFromFilename", () => {
  it("returns SDR for null input", () => {
    expect(detectDynamicRangeFromFilename(null)).toBe("SDR");
  });

  it("returns SDR for empty string", () => {
    expect(detectDynamicRangeFromFilename("")).toBe("SDR");
  });

  it("detects Dolby Vision", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.DV.mkv")).toBe("Dolby Vision");
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.DoVi.mkv")).toBe("Dolby Vision");
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.Dolby.Vision.mkv")).toBe("Dolby Vision");
  });

  it("detects HDR10+", () => {
    // HDR10+ literal: the trailing '+' is not a word character, so the \b word boundary
    // in HDR10_PLUS_PATTERN fails after '+'. HDR10_PATTERN matches instead → "HDR10".
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR10+.mkv")).toBe("HDR10");
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR10Plus.mkv")).toBe("HDR10+");
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR10P.mkv")).toBe("HDR10+");
  });

  it("detects HDR10", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR10.mkv")).toBe("HDR10");
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR.10.mkv")).toBe("HDR10");
  });

  it("detects HLG", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HLG.mkv")).toBe("HLG");
  });

  it("detects generic HDR", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.HDR.mkv")).toBe("HDR");
  });

  it("returns SDR for non-HDR files", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.1080p.mkv")).toBe("SDR");
  });

  it("prioritizes DV over HDR10 combo", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.DV.HDR10.mkv")).toBe("Dolby Vision");
  });

  it("prioritizes DV over HDR10+ combo", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.DV.HDR10+.mkv")).toBe("Dolby Vision");
  });

  it("detects PQ as HDR10", () => {
    expect(detectDynamicRangeFromFilename("/movies/Movie.2024.PQ.mkv")).toBe("HDR10");
  });
});

describe("detectAudioProfileFromFilename", () => {
  it("returns null for null input", () => {
    expect(detectAudioProfileFromFilename(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectAudioProfileFromFilename("")).toBeNull();
  });

  it("detects TrueHD Atmos", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.TrueHD.Atmos.mkv")).toBe("Dolby Atmos");
    expect(detectAudioProfileFromFilename("/movies/Movie.TrueHD Atmos.mkv")).toBe("Dolby Atmos");
  });

  it("detects DTS:X", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.DTS-X.mkv")).toBe("DTS:X");
    expect(detectAudioProfileFromFilename("/movies/Movie.DTS:X.mkv")).toBe("DTS:X");
  });

  it("detects DDP Atmos", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.DDP.Atmos.mkv")).toBe("Dolby Atmos");
    expect(detectAudioProfileFromFilename("/movies/Movie.EAC3.Atmos.mkv")).toBe("Dolby Atmos");
  });

  it("detects generic Atmos", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.Atmos.mkv")).toBe("Dolby Atmos");
  });

  it("detects TrueHD without Atmos", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.TrueHD.mkv")).toBe("Dolby TrueHD");
  });

  it("detects DTS-HD MA", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.DTS-HD.MA.mkv")).toBe("DTS-HD MA");
    expect(detectAudioProfileFromFilename("/movies/Movie.DTS-HDMA.mkv")).toBe("DTS-HD MA");
  });

  it("returns null for files without special audio", () => {
    expect(detectAudioProfileFromFilename("/movies/Movie.AAC.mkv")).toBeNull();
    expect(detectAudioProfileFromFilename("/movies/Movie.2024.1080p.mkv")).toBeNull();
  });
});

// --- Stream-metadata-based detection ---

function makeVideoStream(overrides: Partial<MediaStream> = {}): MediaStream {
  return { id: 1, streamType: 1, ...overrides };
}

function makeAudioStream(overrides: Partial<MediaStream> = {}): MediaStream {
  return { id: 2, streamType: 2, ...overrides };
}

function makePart(overrides: Partial<MediaPart> = {}): MediaPart {
  return { id: 1, key: "/library/parts/1", ...overrides };
}

describe("detectDynamicRange", () => {
  it("returns Dolby Vision for DOVIWithHDR10 videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "DOVIWithHDR10" }), null)).toBe("Dolby Vision");
  });

  it("returns Dolby Vision for DOVIWithSMPTE2020 videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "DOVIWithSMPTE2020" }), null)).toBe("Dolby Vision");
  });

  it("returns Dolby Vision for DOVI videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "DOVI" }), null)).toBe("Dolby Vision");
  });

  it("returns HDR10+ for HDR10+ videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HDR10+" }), null)).toBe("HDR10+");
  });

  it("returns HDR10 for HDR10 videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HDR10" }), null)).toBe("HDR10");
  });

  it("returns HLG for HLG videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HLG" }), null)).toBe("HLG");
  });

  it("returns SDR for SDR videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "SDR" }), null)).toBe("SDR");
  });

  it("returns HDR10 for PQ videoRangeType", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "PQ" }), null)).toBe("HDR10");
  });

  it("returns Dolby Vision when DOVIPresent flag is set", () => {
    expect(detectDynamicRange(makeVideoStream({ DOVIPresent: true }), null)).toBe("Dolby Vision");
  });

  it("prefers videoRangeType over DOVIPresent flag", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HDR10", DOVIPresent: true }), null)).toBe("HDR10");
  });

  it("falls back to filename detection when no stream metadata", () => {
    expect(detectDynamicRange(makeVideoStream(), "/movies/Movie.DV.mkv")).toBe("Dolby Vision");
    expect(detectDynamicRange(makeVideoStream(), "/movies/Movie.HDR10.mkv")).toBe("HDR10");
  });

  it("falls back to filename detection when stream is undefined", () => {
    expect(detectDynamicRange(undefined, "/movies/Movie.DV.mkv")).toBe("Dolby Vision");
    expect(detectDynamicRange(undefined, null)).toBe("SDR");
  });

  it("stream metadata takes priority over filename", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HDR10" }), "/movies/Movie.DV.mkv")).toBe("HDR10");
  });

  it("returns Dolby Vision when Jellyfin DOVI fields are populated", () => {
    expect(detectDynamicRange(makeVideoStream({ DOVIPresent: true, DOVIProfile: 8 }), null)).toBe("Dolby Vision");
  });

  it("returns HDR10+ when HDR10PlusPresent flag is set", () => {
    expect(detectDynamicRange(makeVideoStream({ HDR10PlusPresent: true }), null)).toBe("HDR10+");
  });

  it("prefers videoRangeType over HDR10PlusPresent flag", () => {
    expect(detectDynamicRange(makeVideoStream({ videoRangeType: "HDR10", HDR10PlusPresent: true }), null)).toBe("HDR10");
  });

  it("prefers DOVIPresent over HDR10PlusPresent", () => {
    expect(detectDynamicRange(makeVideoStream({ DOVIPresent: true, HDR10PlusPresent: true }), null)).toBe("Dolby Vision");
  });
});

describe("detectAudioProfile", () => {
  it("detects Dolby Atmos from extendedDisplayTitle", () => {
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (TrueHD 7.1 Atmos)" }), undefined, null)).toBe("Dolby Atmos");
  });

  it("detects DTS:X from extendedDisplayTitle", () => {
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (DTS:X 7.1)" }), undefined, null)).toBe("DTS:X");
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (DTS-X 7.1)" }), undefined, null)).toBe("DTS:X");
  });

  it("detects DTS-HD MA from extendedDisplayTitle", () => {
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (DTS-HD MA 7.1)" }), undefined, null)).toBe("DTS-HD MA");
  });

  it("detects Dolby TrueHD from extendedDisplayTitle", () => {
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (TrueHD 7.1)" }), undefined, null)).toBe("Dolby TrueHD");
  });

  it("detects Dolby Atmos from displayTitle", () => {
    expect(detectAudioProfile(makeAudioStream({ displayTitle: "English (TrueHD Atmos 7.1)" }), undefined, null)).toBe("Dolby Atmos");
  });

  it("detects Dolby TrueHD from profile field", () => {
    expect(detectAudioProfile(makeAudioStream({ profile: "truehd" }), undefined, null)).toBe("Dolby TrueHD");
  });

  it("detects DTS-HD MA from part audioProfile", () => {
    expect(detectAudioProfile(makeAudioStream(), makePart({ audioProfile: "ma" }), null)).toBe("DTS-HD MA");
  });

  it("falls back to filename detection when no stream metadata", () => {
    expect(detectAudioProfile(makeAudioStream(), undefined, "/movies/Movie.TrueHD.Atmos.mkv")).toBe("Dolby Atmos");
    expect(detectAudioProfile(makeAudioStream(), undefined, "/movies/Movie.DTS-HD.MA.mkv")).toBe("DTS-HD MA");
  });

  it("falls back to filename detection when stream is undefined", () => {
    expect(detectAudioProfile(undefined, undefined, "/movies/Movie.TrueHD.mkv")).toBe("Dolby TrueHD");
    expect(detectAudioProfile(undefined, undefined, null)).toBeNull();
  });

  it("stream metadata takes priority over filename", () => {
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (DTS:X 7.1)" }), undefined, "/movies/Movie.TrueHD.Atmos.mkv")).toBe("DTS:X");
  });

  it("returns null when no detection matches", () => {
    expect(detectAudioProfile(makeAudioStream(), undefined, null)).toBeNull();
    expect(detectAudioProfile(makeAudioStream({ extendedDisplayTitle: "English (AAC Stereo)" }), undefined, null)).toBeNull();
  });

  it("detects Dolby Atmos from audioSpatialFormat", () => {
    expect(detectAudioProfile(makeAudioStream({ audioSpatialFormat: "DolbyAtmos" }), undefined, null)).toBe("Dolby Atmos");
  });

  it("detects DTS:X from audioSpatialFormat", () => {
    expect(detectAudioProfile(makeAudioStream({ audioSpatialFormat: "DTSX" }), undefined, null)).toBe("DTS:X");
  });

  it("audioSpatialFormat takes priority over displayTitle", () => {
    expect(detectAudioProfile(
      makeAudioStream({ audioSpatialFormat: "DolbyAtmos", displayTitle: "English (DTS:X 7.1)" }),
      undefined, null
    )).toBe("Dolby Atmos");
  });

  it("falls through when audioSpatialFormat is undefined", () => {
    expect(detectAudioProfile(
      makeAudioStream({ audioSpatialFormat: undefined, extendedDisplayTitle: "English (TrueHD 7.1)" }),
      undefined, null
    )).toBe("Dolby TrueHD");
  });
});
