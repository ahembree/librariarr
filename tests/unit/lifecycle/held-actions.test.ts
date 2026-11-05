import { describe, it, expect } from "vitest";
import {
  actionHoldOf,
  heldActionCount,
  heldActionsReason,
  heldCountLabel,
  holdReasonOf,
  isActionHeld,
  scopeHoldReason,
  skippedHeldLabel,
} from "@/lib/lifecycle/held-actions";
import { groupScopeHoldReason, groupScopeViolation } from "@/lib/conditions/group-scope";
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
    expect(heldCountLabel(3, held)).toBe("3 held until the next detection run");
    expect(heldCountLabel(2, { scopeHoldReason: "uses per-episode criteria" })).toBe("2 held until the rule set is edited");
    expect(skippedHeldLabel(1)).toBe("Skipped 1 held action");
    expect(skippedHeldLabel(4)).toBe("Skipped 4 held actions");
  });
});

// ─── The rule every execution path checks ───────────────────────────────

const PER_EPISODE = [{
  id: "g1",
  condition: "AND",
  rules: [
    { id: "r1", field: "title", operator: "equals", value: "Show", condition: "AND" },
    { id: "r2", field: "resolution", operator: "equals", value: "4K", condition: "AND" },
  ],
  groups: [],
}];
const SHOW_LEVEL = [{ ...PER_EPISODE[0], rules: [PER_EPISODE[0].rules[0]] }];
const SCOPE_REASON = groupScopeHoldReason(groupScopeViolation("SERIES", true, PER_EPISODE)!);

describe("actionHoldOf", () => {
  it("holds a series- or artist-scoped rule set using per-episode/per-track criteria, with the reason", () => {
    expect(actionHoldOf({ type: "SERIES", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: null })).toEqual({
      kind: "groupScope",
      reason: SCOPE_REASON,
    });
    expect(actionHoldOf({ type: "MUSIC", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: null })?.kind).toBe("groupScope");
  });

  it("names the group-scope hold over an edit's, which detection alone cannot release", () => {
    const since = new Date(SINCE);
    expect(actionHoldOf({ type: "SERIES", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: since })?.kind).toBe("groupScope");
  });

  it("holds an edited rule set until detection re-checks it", () => {
    const since = new Date(SINCE);
    expect(actionHoldOf({ type: "SERIES", seriesScope: true, rules: SHOW_LEVEL, actionsHeldSince: since })).toEqual({ kind: "edited", since });
    expect(actionHoldOf({ type: "MOVIE", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: SINCE })).toEqual({ kind: "edited", since: SINCE });
  });

  it("holds nothing with the scope off, on a movie rule set, or with show-level criteria", () => {
    expect(actionHoldOf({ type: "SERIES", seriesScope: false, rules: PER_EPISODE, actionsHeldSince: null })).toBeNull();
    expect(actionHoldOf({ type: "MUSIC", seriesScope: false, rules: PER_EPISODE, actionsHeldSince: null })).toBeNull();
    expect(actionHoldOf({ type: "MOVIE", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: null })).toBeNull();
    expect(actionHoldOf({ type: "SERIES", seriesScope: true, rules: SHOW_LEVEL, actionsHeldSince: null })).toBeNull();
  });
});

describe("scopeHoldReason", () => {
  it("is the group-scope hold's reason alone — never an edit's", () => {
    expect(scopeHoldReason({ type: "SERIES", seriesScope: true, rules: PER_EPISODE })).toBe(SCOPE_REASON);
    expect(scopeHoldReason({ type: "SERIES", seriesScope: false, rules: PER_EPISODE })).toBeNull();
  });
});

describe("the Pending page's reading of both holds", () => {
  const scoped = { actionsHeldSince: null, scopeHoldReason: SCOPE_REASON };

  it("holds a group-scope-held rule set's pending and failed actions, with its reason", () => {
    expect(isActionHeld(scoped, { status: "PENDING" })).toBe(true);
    expect(isActionHeld(scoped, { status: "FAILED" })).toBe(true);
    expect(isActionHeld(scoped, { status: "COMPLETED" })).toBe(false);
    expect(heldActionCount({ ruleSet: scoped, items: [{ status: "PENDING" }, { status: "FAILED" }] })).toBe(2);
    expect(holdReasonOf(scoped)).toBe(SCOPE_REASON);
    expect(holdReasonOf({ ...scoped, actionsHeldSince: SINCE })).toBe(SCOPE_REASON);
  });

  it("reads an edit's hold as before, and nothing for an unheld rule set", () => {
    expect(holdReasonOf(held)).toBe(heldActionsReason(SINCE));
    expect(holdReasonOf(unheld)).toBeNull();
    expect(holdReasonOf({})).toBeNull();
  });
});
