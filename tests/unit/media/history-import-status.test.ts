import { describe, it, expect } from "vitest";
import {
  backfillPercent,
  failedSyncServerNames,
  importBackfillPercent,
  isImportPending,
} from "@/lib/media/history-import-status";

describe("isImportPending", () => {
  it("trusts the route's pending flag over backfillComplete", () => {
    // A disabled server, or a mapping with no plays: never complete, nothing owed.
    expect(isImportPending({ backfillComplete: false, backfillFraction: null, pending: false })).toBe(false);
    expect(isImportPending({ backfillComplete: false, backfillFraction: 0.3, pending: true })).toBe(true);
  });

  it("falls back to !backfillComplete when the route does not report pending", () => {
    expect(isImportPending({ backfillComplete: false, backfillFraction: null })).toBe(true);
    expect(isImportPending({ backfillComplete: true, backfillFraction: 1 })).toBe(false);
  });
});

describe("importBackfillPercent", () => {
  it("reports the least-advanced pending server", () => {
    expect(
      importBackfillPercent([
        { backfillComplete: false, backfillFraction: 0.8, pending: true },
        { backfillComplete: false, backfillFraction: 0.25, pending: true },
        { backfillComplete: false, backfillFraction: 0.01, pending: false },
      ]),
    ).toBe(25);
  });

  it("is null when a pending server is unmeasured or nothing is pending", () => {
    expect(
      importBackfillPercent([
        { backfillComplete: false, backfillFraction: 0.8, pending: true },
        { backfillComplete: false, backfillFraction: null, pending: true },
      ]),
    ).toBeNull();
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: null, pending: false }])).toBeNull();
  });

  it("never reads 100% while a server is still importing", () => {
    // Math.round turned the last half-percent of a walk into "100%" next to
    // "Still importing older history".
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0.995, pending: true }])).toBe(99);
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0.9999, pending: true }])).toBe(99);
    // A fraction of exactly 1 on a server still reported pending (the route
    // measured the span complete before the walk confirmed the end).
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 1, pending: true }])).toBe(99);
    // Floors rather than rounds below the cap too: 12.6% is not yet 13%.
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0.126, pending: true }])).toBe(12);
  });

  it("does not floor an exact percentage one short", () => {
    // 0.29 * 100 === 28.999999999999996 and 0.57 * 100 === 56.99999999999999.
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0.29, pending: true }])).toBe(29);
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0.57, pending: true }])).toBe(57);
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: 0, pending: true }])).toBe(0);
  });

  it("treats a non-finite fraction as unmeasured rather than printing NaN%", () => {
    expect(importBackfillPercent([{ backfillComplete: false, backfillFraction: Number.NaN, pending: true }])).toBeNull();
  });
});

describe("backfillPercent", () => {
  // The one rule the History note AND the Settings bar/live line use. Settings
  // used Math.round, so from 99.5% on it read "100%" beside a spinning
  // "Importing history".
  it("never reads 100 while the backfill is unfinished", () => {
    expect(backfillPercent(0.995, false)).toBe(99);
    expect(backfillPercent(0.9999, false)).toBe(99);
    expect(backfillPercent(1, false)).toBe(99);
  });

  it("reads 100 once the backfill is complete", () => {
    expect(backfillPercent(1, true)).toBe(100);
    // `complete` is the authority, not the arithmetic.
    expect(backfillPercent(0.97, true)).toBe(100);
  });

  it("floors, without flooring an exact percentage one short", () => {
    expect(backfillPercent(0.126, false)).toBe(12);
    expect(backfillPercent(0.29, false)).toBe(29);
    expect(backfillPercent(0.57, false)).toBe(57);
    expect(backfillPercent(0, false)).toBe(0);
  });

  it("clamps out-of-range and non-finite fractions", () => {
    expect(backfillPercent(-0.2, false)).toBe(0);
    expect(backfillPercent(1.4, false)).toBe(99);
    expect(backfillPercent(Number.NaN, false)).toBe(0);
  });
});

describe("failedSyncServerNames", () => {
  it("names every server the sync reported as -1", () => {
    const servers = [
      { id: "a", name: "Living Room" },
      { id: "b", name: "Basement" },
    ];
    expect(failedSyncServerNames({ a: 12, b: -1 }, servers)).toEqual(["Basement"]);
    expect(failedSyncServerNames({ a: -1, gone: -1 }, servers)).toEqual(["Living Room", "gone"]);
    expect(failedSyncServerNames(undefined, servers)).toEqual([]);
  });
});
