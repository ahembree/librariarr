import { describe, it, expect } from "vitest";
import {
  actionHoldFor,
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
/** A rule set's action: Delete Files Only, which acts on the matched episodes. */
const FILES = { actionEnabled: true, actionType: "DELETE_FILES_SONARR", addArrTags: [], removeArrTags: [], searchAfterAction: false };
/** Delete from Sonarr, which acts on the whole show. */
const SERIES_DELETE = { ...FILES, actionType: "DELETE_SONARR" };
const subject = (extra: Record<string, unknown>) =>
  ({ type: "SERIES", seriesScope: true, rules: PER_EPISODE, actionsHeldSince: null, ...FILES, ...extra }) as Parameters<typeof actionHoldOf>[0];

describe("actionHoldOf", () => {
  it("holds a series- or artist-scoped rule set using per-episode/per-track criteria, with the reason", () => {
    expect(actionHoldOf(subject({}))).toEqual({ kind: "groupScope", reason: SCOPE_REASON });
    expect(actionHoldOf(subject({ type: "MUSIC", actionType: "DELETE_FILES_LIDARR" }))?.kind).toBe("groupScope");
  });

  it("holds one whose action acts on the whole show while its scope is off, with the reason", () => {
    const hold = actionHoldOf(subject({ seriesScope: false, ...SERIES_DELETE }));
    expect(hold).toEqual({
      kind: "groupScope",
      reason: groupScopeHoldReason(groupScopeViolation("SERIES", false, PER_EPISODE, SERIES_DELETE)!),
    });
    expect(hold?.kind === "groupScope" && hold.reason).toMatch(/^This rule set's action \("Delete from Sonarr"\) acts on the whole show/);
    for (const action of [
      { actionType: "UNMONITOR_DELETE_FILES_SONARR" },
      { actionType: "MONITOR_DELETE_FILES_SONARR" },
      { actionType: "CHANGE_QUALITY_PROFILE_SONARR" },
      { actionType: "DO_NOTHING", addArrTags: ["seen"] },
    ]) {
      expect(actionHoldOf(subject({ seriesScope: false, ...action }))?.kind, action.actionType).toBe("groupScope");
    }
    // Its action turned off runs nothing: nothing to hold.
    expect(actionHoldOf(subject({ seriesScope: false, ...SERIES_DELETE, actionEnabled: false }))).toBeNull();
  });

  it("names the group-scope hold over an edit's, which detection alone cannot release", () => {
    const since = new Date(SINCE);
    expect(actionHoldOf(subject({ actionsHeldSince: since }))?.kind).toBe("groupScope");
  });

  it("holds an edited rule set until detection re-checks it", () => {
    const since = new Date(SINCE);
    expect(actionHoldOf(subject({ rules: SHOW_LEVEL, actionsHeldSince: since }))).toEqual({ kind: "edited", since });
    expect(actionHoldOf(subject({ type: "MOVIE", actionsHeldSince: SINCE }))).toEqual({ kind: "edited", since: SINCE });
  });

  it("holds nothing with the scope off under an action on the matched members, on a movie rule set, or with show-level criteria", () => {
    expect(actionHoldOf(subject({ seriesScope: false }))).toBeNull();
    expect(actionHoldOf(subject({ type: "MUSIC", seriesScope: false, actionType: "DELETE_FILES_LIDARR" }))).toBeNull();
    expect(actionHoldOf(subject({ type: "MOVIE", actionType: "DELETE_RADARR" }))).toBeNull();
    expect(actionHoldOf(subject({ rules: SHOW_LEVEL, ...SERIES_DELETE }))).toBeNull();
  });
});

describe("actionHoldFor", () => {
  it("holds a scheduled action whose own snapshot acts on the whole show, though the rule set's does not", () => {
    // A restore, or a row written before the rule: the rule set now deletes
    // files, but this action still deletes the series.
    const ruleSet = subject({ seriesScope: false });
    expect(actionHoldOf(ruleSet)).toBeNull();
    expect(actionHoldFor(ruleSet, { actionType: "DELETE_SONARR", addArrTags: [], removeArrTags: [], searchAfterAction: false })?.kind).toBe("groupScope");
    expect(actionHoldFor(ruleSet, { actionType: "DELETE_FILES_SONARR", addArrTags: ["x"], removeArrTags: [] })?.kind).toBe("groupScope");
    expect(actionHoldFor(ruleSet, { actionType: "DELETE_FILES_SONARR", addArrTags: [], removeArrTags: [] })).toBeNull();
  });

  it("reads the snapshot as armed even when the rule set's action is off", () => {
    expect(actionHoldFor(subject({ seriesScope: false, actionEnabled: false }), { actionType: "DELETE_SONARR" })?.kind).toBe("groupScope");
  });

  it("keeps the rule set's own hold first", () => {
    expect(actionHoldFor(subject({ rules: SHOW_LEVEL, actionsHeldSince: SINCE }), { actionType: "DELETE_SONARR" })).toEqual({ kind: "edited", since: SINCE });
  });
});

describe("scopeHoldReason", () => {
  it("is the group-scope hold's reason alone — never an edit's", () => {
    expect(scopeHoldReason({ type: "SERIES", seriesScope: true, rules: PER_EPISODE, ...FILES })).toBe(SCOPE_REASON);
    expect(scopeHoldReason({ type: "SERIES", seriesScope: false, rules: PER_EPISODE, ...FILES })).toBeNull();
    expect(scopeHoldReason({ type: "SERIES", seriesScope: false, rules: PER_EPISODE, ...SERIES_DELETE })).toMatch(/acts on the whole show/);
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
