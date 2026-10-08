import { describe, it, expect } from "vitest";
import {
  backfillPercent,
  failedSyncServerNames,
  importBackfillPercent,
  isImportPending,
} from "@/lib/media/history-import-status";

const importing = (backfillFraction: number | null, pending = true) => ({
  backfillComplete: false,
  backfillFraction,
  pending,
});

describe("isImportPending", () => {
  it.each([
    // The route's flag wins: a disabled server, or a mapping with no plays, is never complete yet owes nothing.
    [{ backfillComplete: false, backfillFraction: null, pending: false }, false],
    [{ backfillComplete: false, backfillFraction: 0.3, pending: true }, true],
    // Without it, !backfillComplete.
    [{ backfillComplete: false, backfillFraction: null }, true],
    [{ backfillComplete: true, backfillFraction: 1 }, false],
  ])("%o is pending: %s", (status, pending) => {
    expect(isImportPending(status)).toBe(pending);
  });
});

describe("import percentage", () => {
  it.each([
    // Never 100 while still importing, even at a measured fraction of 1.
    [0.995, 99],
    [0.9999, 99],
    [1, 99],
    // Floored, without flooring an exact percentage one short (0.29 * 100 is 28.999…).
    [0.126, 12],
    [0.29, 29],
    [0.57, 57],
    [0, 0],
  ])("reads %d as %d%% on both readouts", (fraction, percent) => {
    expect(backfillPercent(fraction, false)).toBe(percent);
    expect(importBackfillPercent([importing(fraction)])).toBe(percent);
  });

  it("backfillPercent reads 100 only once complete, and clamps", () => {
    expect(backfillPercent(1, true)).toBe(100);
    // `complete` is the authority, not the arithmetic.
    expect(backfillPercent(0.97, true)).toBe(100);
    expect([backfillPercent(-0.2, false), backfillPercent(1.4, false), backfillPercent(Number.NaN, false)]).toEqual([0, 99, 0]);
  });

  it("importBackfillPercent reports the least-advanced pending server, null when one is unmeasured", () => {
    expect(importBackfillPercent([importing(0.8), importing(0.25), importing(0.01, false)])).toBe(25);
    expect(importBackfillPercent([importing(0.8), importing(null)])).toBeNull();
    expect(importBackfillPercent([importing(null, false)])).toBeNull();
    // Not NaN%.
    expect(importBackfillPercent([importing(Number.NaN)])).toBeNull();
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
