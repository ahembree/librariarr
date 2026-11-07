import { describe, it, expect } from "vitest";
import { pushDownGroupNegation } from "@/lib/conditions/negation";
import { buildGroupConditions } from "@/lib/conditions/group-composition";
import { ruleToWhere } from "@/lib/conditions/where-builder";
import { evaluateAllRulesInMemory } from "@/lib/rules/lifecycle-engine";
import type { Condition, ConditionGroup } from "@/lib/conditions/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function makeRule(
  overrides: Partial<Condition> & Pick<Condition, "field" | "operator" | "value">,
): Condition {
  return { id: `r${++idSeq}`, condition: "AND", ...overrides };
}

function makeGroup(rules: Condition[], overrides?: Partial<ConditionGroup>): ConditionGroup {
  return { id: `g${++idSeq}`, condition: "AND", rules, groups: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Transform — structure
// ---------------------------------------------------------------------------

describe("pushDownGroupNegation — structure", () => {
  it("returns the tree unchanged when no group carries negate", () => {
    const groups = [
      makeGroup(
        [
          makeRule({ field: "playCount", operator: "equals", value: "0" }),
          makeRule({ field: "year", operator: "greaterThan", value: "2000", condition: "OR", negate: true }),
        ],
        { groups: [makeGroup([makeRule({ field: "resolution", operator: "equals", value: "sd" })])] },
      ),
    ];
    expect(pushDownGroupNegation(groups)).toEqual(groups);
  });

  it("does not mutate the input tree", () => {
    const groups = [
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], { negate: true }),
    ];
    const snapshot = JSON.parse(JSON.stringify(groups));
    pushDownGroupNegation(groups);
    expect(groups).toEqual(snapshot);
  });

  it("NOT over an AND group flips rules and dualizes connectives (De Morgan)", () => {
    const [g] = pushDownGroupNegation([
      makeGroup(
        [
          makeRule({ field: "playCount", operator: "equals", value: "0" }),
          makeRule({ field: "year", operator: "greaterThan", value: "2000", condition: "AND" }),
        ],
        { negate: true },
      ),
    ]);
    expect(g.negate).toBeFalsy();
    expect(g.rules.map((r) => r.negate)).toEqual([true, true]);
    expect(g.rules.map((r) => r.condition)).toEqual(["OR", "OR"]);
  });

  it("double negation on a rule cancels (negated rule inside NOT group)", () => {
    const [g] = pushDownGroupNegation([
      makeGroup(
        [makeRule({ field: "playCount", operator: "equals", value: "0", negate: true })],
        { negate: true },
      ),
    ]);
    expect(g.rules[0].negate).toBe(false);
  });

  it("mixed-connective chains dualize stepwise: NOT((A AND B) OR C) → (¬A OR ¬B) AND ¬C", () => {
    const [g] = pushDownGroupNegation([
      makeGroup(
        [
          makeRule({ field: "a", operator: "equals", value: "1" }),
          makeRule({ field: "b", operator: "equals", value: "2", condition: "AND" }),
          makeRule({ field: "c", operator: "equals", value: "3", condition: "OR" }),
        ],
        { negate: true },
      ),
    ]);
    expect(g.rules.map((r) => r.condition)).toEqual(["OR", "OR", "AND"]);
    expect(g.rules.every((r) => r.negate)).toBe(true);
  });

  it("pushes through nested sub-groups by flipping their flag, cancelling double NOT", () => {
    const inner = makeGroup(
      [makeRule({ field: "resolution", operator: "equals", value: "sd", condition: "OR" })],
      { condition: "OR", negate: true },
    );
    const [g] = pushDownGroupNegation([
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], {
        negate: true,
        groups: [inner],
      }),
    ]);
    // outer NOT flips the inner group's NOT → inner ends up plain
    const sub = g.groups[0];
    expect(g.negate).toBeFalsy();
    expect(sub.negate).toBeFalsy();
    expect(sub.condition).toBe("AND"); // dualized join connective
    // inner group's own contents untouched (its NOT was cancelled, not applied)
    expect(sub.rules[0].negate).toBeFalsy();
    expect(sub.rules[0].condition).toBe("OR");
  });

  it("a negated sub-group under a plain parent is normalized too", () => {
    const inner = makeGroup(
      [makeRule({ field: "resolution", operator: "equals", value: "sd" })],
      { negate: true },
    );
    const [g] = pushDownGroupNegation([
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], {
        groups: [inner],
      }),
    ]);
    expect(g.groups[0].negate).toBeFalsy();
    expect(g.groups[0].rules[0].negate).toBe(true);
  });

  it("maps stream-query NOT onto the quantifier (any ↔ none)", () => {
    const sq = (quantifier: "any" | "none" | undefined) =>
      pushDownGroupNegation([
        makeGroup([makeRule({ field: "sqCodec", operator: "equals", value: "aac" })], {
          negate: true,
          streamQuery: { streamType: "audio", ...(quantifier ? { quantifier } : {}) },
        }),
      ])[0];
    expect(sq("any").streamQuery?.quantifier).toBe("none");
    expect(sq(undefined).streamQuery?.quantifier).toBe("none"); // default is "any"
    expect(sq("none").streamQuery?.quantifier).toBe("any");
    // rules inside an any/none stream query are never flipped by group NOT
    expect(sq("any").rules[0].negate).toBeFalsy();
  });

  // NOT all(r1 AND r2) = some stream fails r1 or r2 = any(¬r1) OR any(¬r2).
  // The NOT used to be dropped, leaving all(r1 AND r2).
  it("rewrites a negated 'all' stream query as an OR of single-rule 'any' queries, each rule negated", () => {
    const [g] = pushDownGroupNegation([
      makeGroup(
        [
          makeRule({ id: "lang", field: "sqLanguage", operator: "equals", value: "English" }),
          makeRule({ id: "codec", field: "sqCodec", operator: "equals", value: "aac", negate: true }),
          makeRule({ id: "off", field: "sqChannels", operator: "equals", value: "2", enabled: false }),
        ],
        { id: "sq", negate: true, condition: "OR", streamQuery: { streamType: "audio", quantifier: "all" } },
      ),
    ]);
    expect(g.negate).toBeFalsy();
    expect(g.streamQuery).toBeUndefined();
    expect(g.condition).toBe("OR"); // its own connective to its siblings is kept
    expect(g.rules).toEqual([]);
    expect(g.groups.map((b) => [b.condition, b.streamQuery, b.rules.map((r) => [r.id, r.negate])])).toEqual([
      ["AND", { streamType: "audio", quantifier: "any" }, [["lang", true]]],
      ["OR", { streamType: "audio", quantifier: "any" }, [["codec", false]]],
    ]);
    expect(g.groups.every((b) => !b.negate)).toBe(true);
  });

  it("leaves a negated 'all' stream query with no enabled rule matching nothing", () => {
    const [g] = pushDownGroupNegation([
      makeGroup([makeRule({ field: "sqCodec", operator: "equals", value: "aac", enabled: false })], {
        negate: true,
        streamQuery: { streamType: "audio", quantifier: "all" },
      }),
    ]);
    expect(g.negate).toBeFalsy();
    expect(g.streamQuery?.quantifier).toBe("all");
    expect(evaluateAllRulesInMemory([g], { streams: [{ streamType: 2, codec: "dts" }] })).toBe(false);
  });

  it("negates an 'all' stream query nested in a NOT group exactly in both phases", () => {
    // NOT (playCount = 0 AND all audio codec = aac)
    const groups = [
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], {
        negate: true,
        groups: [
          makeGroup([makeRule({ field: "sqCodec", operator: "equals", value: "aac" })], {
            streamQuery: { streamType: "audio", quantifier: "all" },
          }),
        ],
      }),
    ];
    const aac = { playCount: 0, streams: [{ streamType: 2, codec: "aac" }] };
    const dts = { playCount: 0, streams: [{ streamType: 2, codec: "aac" }, { streamType: 2, codec: "dts" }] };
    const silent = { playCount: 0, streams: [] };
    expect(evaluateAllRulesInMemory(groups, aac)).toBe(false);
    expect(evaluateAllRulesInMemory(groups, dts)).toBe(true);
    // No audio stream: no stream fails the rule, so NOT all matches nothing here.
    expect(evaluateAllRulesInMemory(groups, silent)).toBe(false);
    // Phase 1: NOT playCount = 0, OR some audio stream whose codec is not aac.
    expect(buildGroupConditions(groups, ruleToWhere)).toEqual({
      OR: [
        { NOT: { playCount: 0 } },
        {
          streams: {
            some: {
              streamType: 2,
              AND: [{ OR: [{ codec: null }, { NOT: { codec: { equals: "aac", mode: "insensitive" } } }] }],
            },
          },
        },
      ],
    });
  });

  it("preserves enabled flags and ids", () => {
    const [g] = pushDownGroupNegation([
      makeGroup(
        [makeRule({ field: "a", operator: "equals", value: "1", enabled: false })],
        { id: "keep-me", negate: true, enabled: true },
      ),
    ]);
    expect(g.id).toBe("keep-me");
    expect(g.rules[0].enabled).toBe(false);
    expect(g.rules[0].negate).toBe(true); // flipped even while disabled — stays skipped either way
  });
});

// ---------------------------------------------------------------------------
// Phase 2 behavior — group NOT end-to-end through the in-memory evaluator
// ---------------------------------------------------------------------------

describe("group-level NOT — in-memory evaluation", () => {
  const watchedHd = { playCount: 5, resolution: "1080" };
  const unwatchedSd = { playCount: 0, resolution: "sd" };

  it("inverts a simple group", () => {
    const groups = [
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], { negate: true }),
    ];
    expect(evaluateAllRulesInMemory(groups, unwatchedSd)).toBe(false);
    expect(evaluateAllRulesInMemory(groups, watchedHd)).toBe(true);
  });

  it("NOT(A AND B) matches items failing either condition", () => {
    const groups = [
      makeGroup(
        [
          makeRule({ field: "playCount", operator: "equals", value: "0" }),
          makeRule({ field: "resolution", operator: "equals", value: "sd", condition: "AND" }),
        ],
        { negate: true },
      ),
    ];
    expect(evaluateAllRulesInMemory(groups, unwatchedSd)).toBe(false); // matches both → excluded
    expect(evaluateAllRulesInMemory(groups, watchedHd)).toBe(true); // fails both → included
    expect(evaluateAllRulesInMemory(groups, { playCount: 0, resolution: "1080" })).toBe(true); // fails one
  });

  it("negated sub-group combines with parent conditions", () => {
    // playCount = 0 AND NOT(resolution = sd OR resolution = 720)
    const groups = [
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], {
        groups: [
          makeGroup(
            [
              makeRule({ field: "resolution", operator: "equals", value: "sd", condition: "OR" }),
              makeRule({ field: "resolution", operator: "equals", value: "720", condition: "OR" }),
            ],
            { condition: "AND", negate: true },
          ),
        ],
      }),
    ];
    expect(evaluateAllRulesInMemory(groups, { playCount: 0, resolution: "1080" })).toBe(true);
    expect(evaluateAllRulesInMemory(groups, { playCount: 0, resolution: "sd" })).toBe(false);
    expect(evaluateAllRulesInMemory(groups, { playCount: 3, resolution: "1080" })).toBe(false);
  });

  it("NOT over an empty or fully-disabled group stays skipped (never matches everything)", () => {
    const emptyNegated = [makeGroup([], { negate: true })];
    expect(evaluateAllRulesInMemory(emptyNegated, watchedHd)).toBe(false);

    const disabledNegated = [
      makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0", enabled: false })], {
        negate: true,
      }),
    ];
    expect(evaluateAllRulesInMemory(disabledNegated, watchedHd)).toBe(false);
  });

  it("double group negation is identity", () => {
    const base = [makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })])];
    // NOT(NOT(group)) via nesting
    const doubled = [
      makeGroup([], {
        negate: true,
        groups: [
          makeGroup([makeRule({ field: "playCount", operator: "equals", value: "0" })], { negate: true }),
        ],
      }),
    ];
    expect(evaluateAllRulesInMemory(base, unwatchedSd)).toBe(true);
    expect(evaluateAllRulesInMemory(base, watchedHd)).toBe(false);
    expect(evaluateAllRulesInMemory(doubled, unwatchedSd)).toBe(true);
    expect(evaluateAllRulesInMemory(doubled, watchedHd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 / Phase 2 agreement — the WHERE built for a negated group equals
// the WHERE built for its hand-flipped De Morgan equivalent
// ---------------------------------------------------------------------------

describe("group-level NOT — Phase 1 WHERE equivalence", () => {
  // Stub rule builder that encodes (field, operator, value, negate) — enough
  // to prove the composition is structurally identical.
  const stubRuleToWhere = (rule: Condition) =>
    ({ [`${rule.field}:${rule.operator}:${rule.value}:${rule.negate ? "NOT" : "POS"}`]: true }) as never;

  it("negated group composes the same WHERE as the manual De Morgan rewrite", () => {
    const negated = [
      makeGroup(
        [
          makeRule({ id: "a", field: "x", operator: "equals", value: "1" }),
          makeRule({ id: "b", field: "y", operator: "greaterThan", value: "2", condition: "AND" }),
        ],
        { negate: true },
      ),
    ];
    const manual = [
      makeGroup(
        [
          makeRule({ id: "a", field: "x", operator: "equals", value: "1", negate: true, condition: "OR" }),
          makeRule({ id: "b", field: "y", operator: "greaterThan", value: "2", condition: "OR", negate: true }),
        ],
        { negate: false },
      ),
    ];
    const expected = { OR: [{ "x:equals:1:NOT": true }, { "y:greaterThan:2:NOT": true }] };
    expect(buildGroupConditions(negated, stubRuleToWhere)).toEqual(expected);
    expect(buildGroupConditions(manual, stubRuleToWhere)).toEqual(expected);
  });
});
