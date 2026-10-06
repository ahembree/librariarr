import { describe, it, expect } from "vitest";
import {
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
