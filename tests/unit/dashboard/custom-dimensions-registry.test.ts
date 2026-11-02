import { describe, it, expect } from "vitest";
import {
  DIMENSION_REGISTRY,
  DATE_DIMENSION_IDS,
  getDimensionMeta,
  getDimensionsByGroup,
} from "@/lib/dashboard/custom-dimensions";

function resolutionBin(raw: string | null): string {
  const fn = getDimensionMeta("resolution")?.valueMapFn;
  if (!fn) throw new Error("resolution has no value map");
  return fn(raw);
}

describe("resolution value map", () => {
  it.each([
    [null, "Unknown"],
    ["", "Unknown"],
    ["4k", "4K"],
    ["4K", "4K"],
    ["2160p", "4K"],
    ["1080", "1080P"],
    ["1080p", "1080P"],
    ["720", "720P"],
    ["480p", "480P"],
    ["360", "SD"],
    ["sd", "SD"],
    ["SD", "SD"],
  ])("maps a known value %s to %s", (raw, expected) => {
    expect(resolutionBin(raw)).toBe(expected);
  });

  it.each([
    ["2880", "4K"],
    ["2000", "4K"],
    ["1440", "1080P"],
    ["900", "1080P"],
    ["800", "720P"],
    ["600", "720P"],
    ["576", "480P"],
    ["300", "480P"],
    ["240", "SD"],
  ])("bins an unlisted height %s to %s", (raw, expected) => {
    expect(resolutionBin(raw)).toBe(expected);
  });

  it("labels a non-numeric unknown value as Other", () => {
    expect(resolutionBin("hd-ready")).toBe("Other");
  });
});

describe("registry lookups", () => {
  it("finds dimensions by id and returns undefined for an unknown one", () => {
    expect(getDimensionMeta("genre")?.category).toBe("json_unnest");
    expect(getDimensionMeta("nope")).toBeUndefined();
  });

  it("collects the date dimensions", () => {
    expect([...DATE_DIMENSION_IDS].sort()).toEqual(["addedAt", "lastPlayedAt", "originallyAvailableAt"]);
  });

  it("groups every dimension once, keeping registry order within a group", () => {
    const groups = getDimensionsByGroup();
    const all = [...groups.values()].flat();
    expect(all).toHaveLength(DIMENSION_REGISTRY.length);
    expect([...groups.keys()]).toEqual(["Video", "Audio", "Streams", "Content", "File", "Dates", "Engagement"]);
    expect(groups.get("Streams")?.map((d) => d.id)).toEqual(["audioLanguage", "subtitleLanguage"]);
  });

  it("gives every numeric bucket contiguous ranges that are open at both ends", () => {
    for (const dim of DIMENSION_REGISTRY.filter((d) => d.category === "numeric_bucket")) {
      const ranges = dim.bucketConfig?.ranges ?? [];
      expect(ranges.length, dim.id).toBeGreaterThan(1);
      expect(ranges[0][0], dim.id).toBeNull();
      expect(ranges[ranges.length - 1][1], dim.id).toBeNull();
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i][0], dim.id).toBe(ranges[i - 1][1]);
      }
    }
  });
});
