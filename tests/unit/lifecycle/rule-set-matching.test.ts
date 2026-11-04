import { describe, it, expect } from "vitest";
import { rulesChanged, serverIdsChanged } from "@/lib/lifecycle/rule-set-matching";

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
