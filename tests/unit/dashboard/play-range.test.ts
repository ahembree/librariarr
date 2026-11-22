import { describe, it, expect } from "vitest";
import { PLAY_RANGE_OPTIONS, isPlayRange, playRangeLabel, playRangeSince } from "@/lib/dashboard/play-range";

describe("play-range", () => {
  it("offers the four presets", () => {
    expect(PLAY_RANGE_OPTIONS.map((o) => o.value)).toEqual(["week", "month", "3months", "year"]);
  });

  it("recognises only the presets", () => {
    for (const o of PLAY_RANGE_OPTIONS) expect(isPlayRange(o.value)).toBe(true);
    for (const v of ["", "all", "day", null, undefined, 7]) expect(isPlayRange(v)).toBe(false);
  });

  it("labels a preset, and none as All Time", () => {
    expect(playRangeLabel("3months")).toBe("Last 90 Days");
    expect(playRangeLabel(undefined)).toBe("All Time");
  });

  it("counts each window back from now", () => {
    const now = new Date("2026-06-30T12:00:00Z");
    expect(playRangeSince("week", now).toISOString()).toBe("2026-06-23T12:00:00.000Z");
    expect(playRangeSince("month", now).toISOString()).toBe("2026-05-31T12:00:00.000Z");
    expect(playRangeSince("3months", now).toISOString()).toBe("2026-04-01T12:00:00.000Z");
    expect(playRangeSince("year", now).toISOString()).toBe("2025-06-30T12:00:00.000Z");
  });
});
