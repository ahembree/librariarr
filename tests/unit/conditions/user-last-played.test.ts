import { describe, it, expect } from "vitest";
import {
  USER_LAST_PLAYED_FIELD,
  USER_LAST_PLAYED_MAP,
  isUserLastPlayedField,
  latestPlayByUser,
  ruleUserOf,
  userLastPlayedOf,
} from "@/lib/conditions/user-last-played";
import { getConditionField } from "@/lib/conditions/fields";
import { hasPlayActivityRules, hasUserLastPlayedRules, hasWatchedByUserRules } from "@/lib/conditions/helpers";
import { ruleToWhere, UNSATISFIABLE_WHERE } from "@/lib/conditions/where-builder";
import { isGroupValueField, aggregateEpisodesIntoSeries, serializeSeriesAggregateForEval, MEMBER_VALUE_COLUMNS } from "@/lib/conditions/series-aggregates";
import { isBlockedAtGroupScope } from "@/lib/conditions/group-scope";
import type { Condition, ConditionGroup } from "@/lib/conditions/types";

const rule = (overrides: Partial<Condition> = {}): Condition => ({
  id: "r",
  field: USER_LAST_PLAYED_FIELD,
  operator: "inLastDays",
  value: "30",
  condition: "AND",
  user: "alice",
  ...overrides,
});
const tree = (r: Condition): ConditionGroup[] => [{ id: "g", condition: "AND", rules: [r], groups: [] }];

describe("User Last Played registration", () => {
  it("is a date criterion in Activity that names a user and reads play activity", () => {
    const def = getConditionField(USER_LAST_PLAYED_FIELD);
    expect(def).toMatchObject({ type: "date", section: "activity", requiresUser: true, readsPlayActivity: true });
    expect(isUserLastPlayedField(USER_LAST_PLAYED_FIELD)).toBe(true);
    expect(isUserLastPlayedField("lastPlayedAt")).toBe(false);
  });

  it("loads watch history, forces Phase 2 and is gated on established play history", () => {
    const groups = tree(rule());
    expect(hasWatchedByUserRules(groups)).toBe(true);
    expect(hasUserLastPlayedRules(groups)).toBe(true);
    expect(hasPlayActivityRules(groups)).toBe(true);
    expect(hasUserLastPlayedRules(tree(rule({ enabled: false })))).toBe(false);
    expect(hasUserLastPlayedRules(tree(rule({ field: "lastPlayedAt" })))).toBe(false);
  });

  it("is a group value: allowed at series scope, one member's own with the scope off", () => {
    expect(isGroupValueField(USER_LAST_PLAYED_FIELD)).toBe(true);
    expect(MEMBER_VALUE_COLUMNS).not.toContain(USER_LAST_PLAYED_FIELD);
    expect(isBlockedAtGroupScope(USER_LAST_PLAYED_FIELD, "SERIES", "group")).toBe(false);
    expect(isBlockedAtGroupScope(USER_LAST_PLAYED_FIELD, "SERIES", "member")).toBe(true);
  });
});

describe("Phase 1", () => {
  it("has no clause with a user, and is dead without one", () => {
    expect(ruleToWhere(rule())).toEqual({});
    expect(ruleToWhere(rule({ negate: true }))).toEqual({});
    expect(ruleToWhere(rule({ user: undefined }))).toEqual(UNSATISFIABLE_WHERE);
    expect(ruleToWhere(rule({ user: "  " }))).toEqual(UNSATISFIABLE_WHERE);
  });
});

describe("ruleUserOf", () => {
  it("trims, and reads anything but a string as no user", () => {
    expect(ruleUserOf({ user: "  alice " })).toBe("alice");
    expect(ruleUserOf({})).toBe("");
    expect(ruleUserOf({ user: 5 })).toBe("");
  });
});

describe("latestPlayByUser", () => {
  it("keeps each user's latest dated play, keyed case-insensitively", () => {
    expect(latestPlayByUser([
      { serverUsername: "Alice", watchedAt: new Date("2026-01-01T00:00:00Z") },
      { serverUsername: "alice", watchedAt: "2026-03-01T00:00:00.000Z" },
      { serverUsername: "alice", watchedAt: new Date("2026-02-01T00:00:00Z") },
      { serverUsername: "bob", watchedAt: null },
      { serverUsername: "carol", watchedAt: "not a date" },
      { serverUsername: null, watchedAt: new Date("2026-04-01T00:00:00Z") },
      { serverUsername: "dave" },
    ])).toEqual({ alice: "2026-03-01T00:00:00.000Z" });
  });

  it("keeps a username that names an Object prototype key as its own key", () => {
    const map = latestPlayByUser([{ serverUsername: "__proto__", watchedAt: "2026-01-01T00:00:00.000Z" }]);
    expect(Object.keys(map)).toEqual(["__proto__"]);
    expect(userLastPlayedOf({ [USER_LAST_PLAYED_MAP]: map }, "__proto__")).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("userLastPlayedOf", () => {
  const item = {
    watchHistory: [
      { serverUsername: "ALICE", watchedAt: new Date("2026-05-01T00:00:00Z") },
      { serverUsername: "alice", watchedAt: new Date("2026-06-01T00:00:00Z") },
      { serverUsername: "bob", watchedAt: new Date("2026-07-01T00:00:00Z") },
      { serverUsername: "alice", watchedAt: null },
    ],
  };

  it("reads the user's latest dated play off the item's rows", () => {
    expect(userLastPlayedOf(item, "Alice")).toBe("2026-06-01T00:00:00.000Z");
    expect(userLastPlayedOf(item, " bob ")).toBe("2026-07-01T00:00:00.000Z");
    expect(userLastPlayedOf(item, "carol")).toBeNull();
    expect(userLastPlayedOf(item, "")).toBeNull();
    expect(userLastPlayedOf({}, "alice")).toBeNull();
  });

  it("reads a group record's map in place of rows", () => {
    const group = { ...item, [USER_LAST_PLAYED_MAP]: { alice: "2020-01-01T00:00:00.000Z" } };
    expect(userLastPlayedOf(group, "ALICE")).toBe("2020-01-01T00:00:00.000Z");
    expect(userLastPlayedOf(group, "bob")).toBeNull();
    expect(userLastPlayedOf(group, "constructor")).toBeNull();
  });
});

describe("series aggregate", () => {
  const ep = (id: string, plays: Array<[string, string]>) => ({
    id,
    parentTitle: "Show",
    libraryId: "L",
    playCount: plays.length,
    fileSize: null,
    lastPlayedAt: null,
    addedAt: null,
    originallyAvailableAt: null,
    seasonNumber: 1,
    episodeNumber: Number(id.slice(1)),
    title: id,
    watchHistory: plays.map(([u, d]) => ({ serverUsername: u, watchedAt: new Date(d) })),
  });

  it("carries each user's latest play of any episode", () => {
    const [series] = aggregateEpisodesIntoSeries([
      ep("e1", [["alice", "2026-01-01T00:00:00Z"], ["bob", "2026-03-01T00:00:00Z"]]),
      ep("e2", [["Alice", "2026-02-01T00:00:00Z"]]),
    ]);
    const serialized = serializeSeriesAggregateForEval(series);
    expect(serialized[USER_LAST_PLAYED_MAP]).toEqual({
      alice: "2026-02-01T00:00:00.000Z",
      bob: "2026-03-01T00:00:00.000Z",
    });
    expect(userLastPlayedOf(serialized, "alice")).toBe("2026-02-01T00:00:00.000Z");
  });
});
