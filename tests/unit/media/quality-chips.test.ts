import { describe, it, expect } from "vitest";
import {
  audioCodecChipLabel,
  audioProfileChipLabel,
  dynamicRangeChipLabel,
  orderedAudioCodecCounts,
  orderedQualityCounts,
  qualityChips,
  qualityChipText,
  qualitySegments,
  resolutionChipLabel,
} from "@/lib/media/quality-chips";

describe("chip labels", () => {
  it("gives a missing value no chip, never a placeholder", () => {
    expect(resolutionChipLabel(null)).toBeNull();
    expect(resolutionChipLabel("  ")).toBeNull();
    expect(dynamicRangeChipLabel(undefined)).toBeNull();
    expect(audioProfileChipLabel("")).toBeNull();
    expect(audioCodecChipLabel(null)).toBeNull();
  });

  it("shows a resolution's standard label, else its own spelling", () => {
    expect(resolutionChipLabel("1080")).toBe("1080P");
    expect(resolutionChipLabel("4k")).toBe("4K");
    expect(resolutionChipLabel("872")).toBe("720P");
    expect(resolutionChipLabel("576i")).toBe("480P");
    expect(resolutionChipLabel("weird")).toBe("weird");
  });

  it("shows SDR like any other dynamic range", () => {
    expect(dynamicRangeChipLabel("SDR")).toBe("SDR");
    expect(dynamicRangeChipLabel("Dolby Vision")).toBe("Dolby Vision");
  });

  it("upper-cases an audio codec", () => {
    expect(audioCodecChipLabel("aac")).toBe("AAC");
    expect(audioCodecChipLabel("eac3")).toBe("EAC3");
  });
});

describe("ordered counts", () => {
  it("orders resolutions canonically and drops empty buckets", () => {
    expect(orderedQualityCounts({ Other: 2, "720P": 1, "4K": 3, SD: 0 })).toEqual([
      ["4K", 3],
      ["720P", 1],
      ["Other", 2],
    ]);
  });

  it("orders codecs canonically, the rest by name, Unknown last", () => {
    expect(orderedAudioCodecCounts({ Unknown: 1, ZZZ: 1, mp3: 2, FLAC: 4, AAA: 1 })).toEqual([
      ["FLAC", 4],
      ["MP3", 2],
      ["AAA", 1],
      ["ZZZ", 1],
      ["Unknown", 1],
    ]);
  });

  it("merges a codec counted under two spellings", () => {
    expect(orderedAudioCodecCounts({ aac: 1, AAC: 2 })).toEqual([["AAC", 3]]);
  });

  it("is empty for no counts", () => {
    expect(orderedQualityCounts(null)).toEqual([]);
    expect(orderedAudioCodecCounts(undefined)).toEqual([]);
  });
});

describe("qualityChips", () => {
  it("gives a video item its resolution, dynamic range and audio profile", () => {
    expect(
      qualityChips({ resolution: "2160", dynamicRange: "SDR", audioProfile: "Dolby Atmos", audioCodec: "truehd" }, "video"),
    ).toEqual([
      { category: "resolution", label: "4K", toggle: "resolution" },
      { category: "dynamicRange", label: "SDR", toggle: "dynamicRange" },
      { category: "audioProfile", label: "Dolby Atmos", toggle: "audioProfile" },
    ]);
  });

  it("gives a track its codec, with channels only when asked", () => {
    expect(qualityChips({ audioCodec: "flac", audioChannels: 2, resolution: "1080" }, "music")).toEqual([
      { category: "audioCodec", label: "FLAC", toggle: "audioCodec" },
    ]);
    expect(qualityChips({ audioCodec: "flac", audioChannels: 2 }, "music", { channels: true })).toEqual([
      { category: "audioCodec", label: "FLAC", toggle: "audioCodec", detail: "2ch" },
    ]);
  });

  it("gives a group its counts instead", () => {
    expect(qualityChips({ qualityCounts: { "1080P": 4 }, resolution: "720" }, "video")).toEqual([
      { category: "resolution", label: "1080P", count: 4, toggle: "qualityCounts" },
    ]);
    expect(qualityChips({ audioCodecCounts: { mp3: 1 } }, "music")).toEqual([
      { category: "audioCodec", label: "MP3", count: 1, toggle: "audioCodecs" },
    ]);
  });

  it("gives an item with nothing known no chips", () => {
    expect(qualityChips({}, "video")).toEqual([]);
    expect(qualityChips({}, "music")).toEqual([]);
  });
});

describe("qualityChipText", () => {
  it("reads the label, its detail and its count", () => {
    expect(qualityChipText({ category: "resolution", label: "4K" })).toBe("4K");
    expect(qualityChipText({ category: "resolution", label: "4K", count: 3 })).toBe("4K: 3");
    expect(qualityChipText({ category: "audioCodec", label: "AAC", detail: "6ch" })).toBe("AAC 6ch");
  });
});

describe("qualitySegments", () => {
  const getHex = (category: string, value: string) => `${category}:${value}`;

  it("draws one segment per chip, weighted by its count", () => {
    const chips = qualityChips({ qualityCounts: { "4K": 2, "720P": 5 } }, "video");
    expect(qualitySegments(chips, getHex)).toEqual([
      { color: "resolution:4K", weight: 2, label: "4K: 2" },
      { color: "resolution:720P", weight: 5, label: "720P: 5" },
    ]);
  });

  it("leaves out a chip the card's display settings hide", () => {
    const chips = qualityChips({ resolution: "1080", dynamicRange: "HDR10" }, "video");
    expect(qualitySegments(chips, getHex, (toggle) => toggle !== "dynamicRange")).toEqual([
      { color: "resolution:1080P", weight: 1, label: "1080P" },
    ]);
  });
});
