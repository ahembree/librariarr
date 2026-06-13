import { describe, it, expect } from "vitest";
import { formatDurationLarge } from "@/lib/format";

/**
 * `formatUntil` and `formatRelativeDate` are already fully covered in
 * tests/unit/format.test.ts. The only function in src/lib/format.ts with no
 * coverage is `formatDurationLarge` (lines 51-73), so this file targets every
 * one of its branches.
 */
describe("formatDurationLarge", () => {
  it("returns '-' for null", () => {
    expect(formatDurationLarge(null)).toBe("-");
  });

  it("returns '-' for zero", () => {
    expect(formatDurationLarge(0)).toBe("-");
  });

  it("formats minutes only when under 1 hour", () => {
    // 5 minutes = 300,000 ms
    expect(formatDurationLarge(300000)).toBe("5m");
    // 0 minutes (rounds from < 30s) → totalHours 0
    expect(formatDurationLarge(1000)).toBe("0m");
  });

  it("formats hours and minutes when under a day", () => {
    // 1 hour 30 minutes = 5,400,000 ms
    expect(formatDurationLarge(5400000)).toBe("1h 30m");
    // 23 hours 59 minutes
    const ms = (23 * 60 + 59) * 60000;
    expect(formatDurationLarge(ms)).toBe("23h 59m");
  });

  it("formats days and hours for 1-29 days", () => {
    // exactly 24 hours → 1d 0h
    expect(formatDurationLarge(24 * 3600000)).toBe("1d 0h");
    // 2 days 5 hours
    expect(formatDurationLarge((2 * 24 + 5) * 3600000)).toBe("2d 5h");
    // 29 days 23 hours (just under the month boundary)
    expect(formatDurationLarge((29 * 24 + 23) * 3600000)).toBe("29d 23h");
  });

  it("formats months and days for 30-364 days", () => {
    // exactly 30 days → 1mo 0d
    expect(formatDurationLarge(30 * 24 * 3600000)).toBe("1mo 0d");
    // 45 days → 1 month (30d) + 15 remaining days
    expect(formatDurationLarge(45 * 24 * 3600000)).toBe("1mo 15d");
    // 90 days → 3 months, 0 remaining
    expect(formatDurationLarge(90 * 24 * 3600000)).toBe("3mo 0d");
  });

  it("formats years and months for 365+ days", () => {
    // exactly 365 days → 1y, remaining months = floor((365-365)/30) = 0
    expect(formatDurationLarge(365 * 24 * 3600000)).toBe("1y 0mo");
    // 400 days → 1y, remaining = floor((400-365)/30) = floor(35/30) = 1mo
    expect(formatDurationLarge(400 * 24 * 3600000)).toBe("1y 1mo");
    // 730 days → 2y, remaining = floor((730-730)/30) = 0mo
    expect(formatDurationLarge(730 * 24 * 3600000)).toBe("2y 0mo");
  });
});
