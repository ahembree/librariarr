import { describe, it, expect } from "vitest";
import {
  DIMENSION_REGISTRY,
  breakdownValueLabel,
  canCrossTabulate,
  getDimensionMeta,
  isSubmittableCustomCard,
  supportsTimelineBreakdown,
} from "@/lib/dashboard/custom-dimensions";

const meta = (id: string) => getDimensionMeta(id)!;

describe("supportsTimelineBreakdown", () => {
  it("refuses dimensions that need a row per value, and dates", () => {
    for (const id of ["genre", "countries", "audioLanguage", "subtitleLanguage", "addedAt", "lastPlayedAt"]) {
      expect(supportsTimelineBreakdown(meta(id))).toBe(false);
    }
  });

  it("accepts single-value dimensions", () => {
    for (const id of ["resolution", "videoCodec", "contentRating", "fileSize", "playCount"]) {
      expect(supportsTimelineBreakdown(meta(id))).toBe(true);
    }
  });

  it("accepts exactly the categories the timeline SQL can express", () => {
    for (const d of DIMENSION_REGISTRY) {
      const expressible = ["direct", "value_map", "numeric_bucket"].includes(d.category);
      expect(supportsTimelineBreakdown(d)).toBe(expressible);
    }
  });
});

describe("canCrossTabulate", () => {
  it("refuses two stream dimensions", () => {
    expect(canCrossTabulate(meta("audioLanguage"), meta("subtitleLanguage"))).toBe(false);
  });

  it("refuses a dimension against itself", () => {
    expect(canCrossTabulate(meta("resolution"), meta("resolution"))).toBe(false);
  });

  it("accepts a stream dimension against a non-stream one", () => {
    expect(canCrossTabulate(meta("audioLanguage"), meta("resolution"))).toBe(true);
    expect(canCrossTabulate(meta("year"), meta("subtitleLanguage"))).toBe(true);
  });
});

describe("breakdownValueLabel", () => {
  it("labels a null value with the dimension's own null label", () => {
    expect(breakdownValueLabel(null, meta("contentRating"))).toBe("Not Rated");
    expect(breakdownValueLabel(null, meta("lastPlayedAt"))).toBe("Never Played");
  });

  it("passes a value through", () => {
    expect(breakdownValueLabel("PG-13", meta("contentRating"))).toBe("PG-13");
  });

  it("falls back to Unknown without metadata", () => {
    expect(breakdownValueLabel(null, undefined)).toBe("Unknown");
  });
});

describe("isSubmittableCustomCard", () => {
  it("needs a dimension", () => {
    expect(isSubmittableCustomCard("bar", "", "")).toBe(false);
    expect(isSubmittableCustomCard("bar", "resolution", "")).toBe(true);
  });

  it("refuses an unknown dimension", () => {
    expect(isSubmittableCustomCard("bar", "nope", "")).toBe(false);
  });

  it("needs a second, different, crossable dimension for a heatmap", () => {
    expect(isSubmittableCustomCard("heatmap", "resolution", "")).toBe(false);
    expect(isSubmittableCustomCard("heatmap", "resolution", "resolution")).toBe(false);
    expect(isSubmittableCustomCard("heatmap", "audioLanguage", "subtitleLanguage")).toBe(false);
    expect(isSubmittableCustomCard("heatmap", "audioLanguage", "resolution")).toBe(true);
  });

  it("needs a date field and an expressible breakdown for a timeline", () => {
    expect(isSubmittableCustomCard("timeline", "resolution", "")).toBe(false);
    expect(isSubmittableCustomCard("timeline", "addedAt", "")).toBe(true);
    expect(isSubmittableCustomCard("timeline", "addedAt", "resolution")).toBe(true);
    expect(isSubmittableCustomCard("timeline", "addedAt", "genre")).toBe(false);
    expect(isSubmittableCustomCard("timeline", "addedAt", "audioLanguage")).toBe(false);
  });
});
