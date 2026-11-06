import { describe, it, expect, vi } from "vitest";
import {
  RULE_SET_VERSION_SELECT,
  lockRuleSetAtVersion,
  releasesStoredMatches,
  rulesChanged,
  ruleSetVersion,
  serverIdsChanged,
  type RuleSetVersionFields,
} from "@/lib/lifecycle/rule-set-matching";

const rules = [
  {
    id: "g1",
    condition: "AND",
    rules: [{ id: "r1", field: "year", operator: "equals", value: "2020", condition: "AND" }],
    groups: [],
  },
];

describe("rulesChanged", () => {
  it("reads the same rules back with their keys in another order as unchanged", () => {
    // Postgres' jsonb reorders object keys.
    const stored = [
      {
        id: "g1",
        rules: [{ id: "r1", value: "2020", field: "year", operator: "equals", condition: "AND" }],
        groups: [],
        condition: "AND",
      },
    ];
    expect(rulesChanged(stored, rules)).toBe(false);
  });

  it("ignores members left undefined", () => {
    expect(rulesChanged(rules, [{ ...rules[0], negate: undefined }])).toBe(false);
  });

  it("sees a changed value, operator, negation, connective or order", () => {
    const rule = rules[0].rules[0];
    const withRule = (r: Record<string, unknown>) => [{ ...rules[0], rules: [{ ...rule, ...r }] }];
    expect(rulesChanged(rules, withRule({ value: "2010" }))).toBe(true);
    expect(rulesChanged(rules, withRule({ value: 2020 }))).toBe(true);
    expect(rulesChanged(rules, withRule({ operator: "greaterThan" }))).toBe(true);
    expect(rulesChanged(rules, withRule({ negate: true }))).toBe(true);
    expect(rulesChanged(rules, [{ ...rules[0], negate: true }])).toBe(true);
    const second = { id: "r2", field: "title", operator: "contains", value: "x", condition: "OR" };
    expect(rulesChanged([{ ...rules[0], rules: [rule, second] }], [{ ...rules[0], rules: [second, rule] }])).toBe(true);
  });

  it("sees a legacy flat rule set rewritten as groups as a change", () => {
    expect(rulesChanged(rules[0].rules, rules)).toBe(true);
  });
});

describe("serverIdsChanged", () => {
  it("ignores order and repeats", () => {
    expect(serverIdsChanged(["a", "b"], ["b", "a", "a"])).toBe(false);
  });

  it("sees a server added or removed", () => {
    expect(serverIdsChanged(["a"], ["a", "b"])).toBe(true);
    expect(serverIdsChanged(["a", "b"], ["a"])).toBe(true);
    expect(serverIdsChanged(["a"], ["b"])).toBe(true);
  });
});

describe("releasesStoredMatches", () => {
  const sticky = { stickyMatches: true, enabled: true };
  const disabled = { stickyMatches: false, enabled: false };

  it("sees sticky matches turned off: what only stickiness kept would run before detection drops it", () => {
    expect(releasesStoredMatches(sticky, { stickyMatches: false })).toBe(true);
    expect(releasesStoredMatches(sticky, { stickyMatches: false, enabled: true })).toBe(true);
  });

  it("sees a disabled rule set enabled again: its matches are as old as the day it was turned off", () => {
    expect(releasesStoredMatches(disabled, { enabled: true })).toBe(true);
    expect(releasesStoredMatches(disabled, { stickyMatches: false, enabled: true })).toBe(true);
  });

  it("ignores turning sticky matches on, disabling, and fields that are not changing", () => {
    expect(releasesStoredMatches(disabled, { stickyMatches: true })).toBe(false);
    expect(releasesStoredMatches(sticky, { stickyMatches: true, enabled: true })).toBe(false);
    expect(releasesStoredMatches(sticky, { enabled: false })).toBe(false);
    expect(releasesStoredMatches(disabled, { stickyMatches: false, enabled: false })).toBe(false);
    expect(releasesStoredMatches(sticky, {})).toBe(false);
    expect(releasesStoredMatches({ stickyMatches: false, enabled: true }, { stickyMatches: false, enabled: true })).toBe(false);
  });
});

describe("ruleSetVersion", () => {
  const row: RuleSetVersionFields = {
    rules,
    seriesScope: true,
    serverIds: ["s1", "s2"],
    arrInstanceId: "sonarr-1",
    enabled: true,
    stickyMatches: false,
    actionEnabled: true,
    actionType: "DELETE_FILES_SONARR",
    actionDelayDays: 7,
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    addArrTags: ["a", "b"],
    removeArrTags: [],
  };

  it("is the same for the same rule set read twice, whatever jsonb's key order or the lists' order", () => {
    const reread = {
      ...row,
      rules: [{ groups: [], condition: "AND", id: "g1", rules: [{ ...rules[0].rules[0] }] }],
      serverIds: ["s2", "s1"],
      addArrTags: ["b", "a"],
    };
    expect(ruleSetVersion(reread)).toBe(ruleSetVersion(row));
  });

  it("changes with anything its matches or actions depend on", () => {
    const changes: Array<Partial<RuleSetVersionFields>> = [
      { rules: [{ ...rules[0], negate: true }] },
      { seriesScope: false },
      { serverIds: ["s1"] },
      { arrInstanceId: "sonarr-2" },
      { enabled: false },
      { stickyMatches: true },
      { actionEnabled: false },
      { actionType: "DELETE_SONARR" },
      { actionDelayDays: 0 },
      { targetQualityProfileId: 4 },
      { addImportExclusion: true },
      { searchAfterAction: true },
      { addArrTags: ["a"] },
      { removeArrTags: ["c"] },
    ];
    for (const change of changes) expect(ruleSetVersion({ ...row, ...change }), JSON.stringify(change)).not.toBe(ruleSetVersion(row));
  });

  it("changes when a tag moves from one list to the other: one action adds some tags and removes others", () => {
    expect(ruleSetVersion({ ...row, addArrTags: ["a"], removeArrTags: ["b"] })).not.toBe(ruleSetVersion(row));
    expect(ruleSetVersion({ ...row, addArrTags: [], removeArrTags: ["a", "b"] })).not.toBe(ruleSetVersion(row));
  });

  it("reads exactly the columns it compares", () => {
    expect(Object.keys(RULE_SET_VERSION_SELECT).sort()).toEqual(Object.keys(row).sort());
  });
});

describe("lockRuleSetAtVersion", () => {
  const stored: RuleSetVersionFields = {
    rules, seriesScope: true, serverIds: ["s1"], arrInstanceId: null, enabled: true, stickyMatches: false,
    actionEnabled: true, actionType: "DELETE_RADARR", actionDelayDays: 0, targetQualityProfileId: null,
    addImportExclusion: false, searchAfterAction: false, addArrTags: [], removeArrTags: [],
  };
  const tx = (row: RuleSetVersionFields | null) => ({
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    ruleSet: { findUnique: vi.fn().mockResolvedValue(row) },
  });

  it("locks the row first, then answers whether it is still at the version read", async () => {
    const client = tx(stored);
    expect(await lockRuleSetAtVersion(client, "rs1", ruleSetVersion(stored))).toBe(true);
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(`SELECT "id" FROM "RuleSet" WHERE "id" = $1 FOR UPDATE`, "rs1");
    expect(client.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(client.ruleSet.findUnique.mock.invocationCallOrder[0]);
    expect(client.ruleSet.findUnique).toHaveBeenCalledWith({ where: { id: "rs1" }, select: RULE_SET_VERSION_SELECT });
  });

  it("answers false for a rule set edited, or deleted, since", async () => {
    const edited = tx({ ...stored, rules: [] });
    expect(await lockRuleSetAtVersion(edited, "rs1", ruleSetVersion(stored))).toBe(false);
    expect(await lockRuleSetAtVersion(tx(null), "rs1", ruleSetVersion(stored))).toBe(false);
  });
});
