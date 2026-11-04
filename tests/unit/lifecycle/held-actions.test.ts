import { describe, it, expect } from "vitest";
import {
  heldActionCount,
  heldActionsReason,
  heldCountLabel,
  isActionHeld,
  skippedHeldLabel,
} from "@/lib/lifecycle/held-actions";
import { formatDateTime } from "@/lib/format";

const SINCE = "2026-11-04T03:25:25.000Z";
const held = { actionsHeldSince: SINCE };
const unheld = { actionsHeldSince: null };

describe("isActionHeld", () => {
  it("holds a held rule set's pending and failed actions — what Execute and Retry would run", () => {
    expect(isActionHeld(held, { status: "PENDING" })).toBe(true);
    expect(isActionHeld(held, { status: "FAILED" })).toBe(true);
  });

  it("never holds a completed action, which has nothing left to run", () => {
    expect(isActionHeld(held, { status: "COMPLETED" })).toBe(false);
  });

  it("holds nothing of a rule set that is not held, or a deleted one (no stamp at all)", () => {
    for (const status of ["PENDING", "FAILED", "COMPLETED"]) {
      expect(isActionHeld(unheld, { status })).toBe(false);
      expect(isActionHeld({}, { status })).toBe(false);
    }
  });
});

describe("heldActionCount", () => {
  it("counts every pending and failed row of a held group — Execute All skips them all", () => {
    const items = [{ status: "PENDING" }, { status: "PENDING" }, { status: "FAILED" }, { status: "COMPLETED" }];
    expect(heldActionCount({ ruleSet: held, items })).toBe(3);
  });

  it("is zero for a group whose rule set is not held, so Execute All runs as before", () => {
    expect(heldActionCount({ ruleSet: unheld, items: [{ status: "PENDING" }, { status: "PENDING" }] })).toBe(0);
    expect(heldActionCount({ ruleSet: held, items: [] })).toBe(0);
  });
});

describe("the hold's wording", () => {
  it("says since when, why, and what releases it", () => {
    const reason = heldActionsReason(SINCE);
    expect(reason).toContain(`Held since ${formatDateTime(SINCE)}`);
    expect(reason).toMatch(/rules or servers were edited/);
    expect(reason).toMatch(/wait for the next detection run to re-check its matches/);
    expect(reason).toMatch(/Re-evaluate it on the Matches page/);
  });

  it("counts what Execute All skips", () => {
    expect(heldCountLabel(3)).toBe("3 held until the next detection run");
    expect(skippedHeldLabel(1)).toBe("Skipped 1 held action");
    expect(skippedHeldLabel(4)).toBe("Skipped 4 held actions");
  });
});
