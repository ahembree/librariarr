import { describe, it, expect } from "vitest";
import {
  evaluateAllRulesInMemory,
  getActualValuesForAllRules,
  getMatchedCriteriaForItems,
} from "@/lib/rules/lifecycle-engine";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import { USER_LAST_PLAYED_MAP } from "@/lib/conditions/user-last-played";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function rule(overrides: Partial<LifecycleRule> = {}): LifecycleRule {
  return {
    id: "r1",
    field: "userLastPlayedAt",
    operator: "inLastDays",
    value: "30",
    condition: "AND",
    user: "alice",
    ...overrides,
  };
}
const tree = (...rules: LifecycleRule[]): LifecycleRuleGroup[] => [{ id: "g", condition: "AND", rules, groups: [] }];

/** Both engines must agree; the shared verdict is returned. */
function evalBoth(groups: LifecycleRuleGroup[], item: Record<string, unknown>): boolean {
  const lifecycle = evaluateAllRulesInMemory(groups, item, undefined, undefined);
  const query = evaluateAllQueryRulesInMemory(groups, item, undefined, undefined);
  expect(query).toBe(lifecycle);
  return lifecycle;
}

const item = (plays: Array<[string, Date | null]>) => ({
  id: "m1",
  type: "MOVIE",
  title: "Movie",
  lastPlayedAt: plays.reduce<Date | null>((a, [, d]) => (d && (!a || d > a) ? d : a), null)?.toISOString() ?? null,
  watchHistory: plays.map(([serverUsername, watchedAt]) => ({ serverUsername, watchedAt })),
});

describe("User Last Played in both engines", () => {
  // alice watched it 200 days ago; bob last week.
  const movie = item([["alice", daysAgo(200)], ["bob", daysAgo(7)]]);

  it("judges the named user's play, not anyone's", () => {
    expect(evalBoth(tree(rule()), movie)).toBe(false);
    expect(evalBoth(tree(rule({ user: "bob" })), movie)).toBe(true);
    expect(evalBoth(tree(rule({ user: "BOB" })), movie)).toBe(true);
    // The two-criterion combination this replaces matches it.
    expect(evalBoth(tree(
      { id: "a", field: "watchedByUser", operator: "equals", value: "alice", condition: "AND" },
      { id: "b", field: "lastPlayedAt", operator: "inLastDays", value: "30", condition: "AND" },
    ), movie)).toBe(true);
  });

  it("uses the user's latest play", () => {
    const rewatched = item([["alice", daysAgo(200)], ["alice", daysAgo(3)]]);
    expect(evalBoth(tree(rule()), rewatched)).toBe(true);
    expect(evalBoth(tree(rule({ operator: "notInLastDays" })), rewatched)).toBe(false);
  });

  it("applies the shared date semantics to a user who never played it", () => {
    const unplayed = item([["bob", daysAgo(1)]]);
    expect(evalBoth(tree(rule()), unplayed)).toBe(false);
    expect(evalBoth(tree(rule({ operator: "notInLastDays" })), unplayed)).toBe(false);
    expect(evalBoth(tree(rule({ negate: true })), unplayed)).toBe(true);
    expect(evalBoth(tree(rule({ operator: "isNull", value: "" })), unplayed)).toBe(true);
    expect(evalBoth(tree(rule({ operator: "isNotNull", value: "" })), unplayed)).toBe(false);
    expect(evalBoth(tree(rule({ operator: "isNotNull", value: "" })), movie)).toBe(true);
  });

  it("compares before, after and between on the user's date", () => {
    const dated = item([["alice", new Date("2025-06-15T12:00:00Z")]]);
    expect(evalBoth(tree(rule({ operator: "before", value: "2025-07-01" })), dated)).toBe(true);
    expect(evalBoth(tree(rule({ operator: "after", value: "2025-07-01" })), dated)).toBe(false);
    expect(evalBoth(tree(rule({ operator: "between", value: "2025-06-01,2025-06-30" })), dated)).toBe(true);
    expect(evalBoth(tree(rule({ operator: "equals", value: "2025-06-15" })), dated)).toBe(true);
  });

  it("ignores plays without a date", () => {
    expect(evalBoth(tree(rule({ operator: "isNull", value: "" })), item([["alice", null]]))).toBe(true);
  });

  it("matches nothing without a user, NOT included", () => {
    expect(evalBoth(tree(rule({ user: undefined })), movie)).toBe(false);
    expect(evalBoth(tree(rule({ user: undefined, negate: true })), movie)).toBe(false);
    expect(evalBoth(tree(rule({ user: "", operator: "isNull", value: "" })), movie)).toBe(false);
  });

  it("reads a group record's per-user map", () => {
    const show = { id: "s1", type: "SERIES", title: "Show", watchedByUsers: ["alice"], [USER_LAST_PLAYED_MAP]: { alice: daysAgo(2).toISOString() } };
    expect(evalBoth(tree(rule()), show)).toBe(true);
    expect(evalBoth(tree(rule({ user: "bob" })), show)).toBe(false);
  });
});

describe("User Last Played reporting", () => {
  const movie = item([["alice", new Date("2026-11-20T10:00:00Z")]]);

  it("names the user in the matched criterion and reports that user's date", () => {
    const criteria = getMatchedCriteriaForItems([movie], tree(rule({ operator: "after", value: "2026-11-01" })), "MOVIE").get("m1");
    expect(criteria).toHaveLength(1);
    expect(criteria![0].field).toBe("User Last Played (alice)");
    expect(criteria![0].actualValue).toBeTruthy();
    expect(criteria![0].actualValue).not.toBe("never");
  });

  it("reads 'never' for a user with no play", () => {
    const values = getActualValuesForAllRules([movie], tree(rule({ user: "bob" })), "MOVIE").get("m1");
    expect(values?.get("r1")).toBe("never");
  });
});
