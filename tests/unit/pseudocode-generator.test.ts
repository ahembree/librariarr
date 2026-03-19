import { describe, it, expect, beforeEach } from "vitest";
import {
  generatePseudocode,
  type PseudocodeLine,
} from "@/components/builder/pseudocode-generator";
import type {
  BaseRule,
  BaseGroup,
  BuilderConfig,
} from "@/components/builder/types";

// ─── Test helpers ────────────────────────────────────────────────────────────

let idSeq = 0;
function id(): string {
  return `test-${++idSeq}`;
}

function makeRule(
  overrides: Partial<BaseRule> = {},
): BaseRule {
  return {
    id: id(),
    field: "playCount",
    operator: "equals",
    value: "0",
    condition: "AND",
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<BaseGroup<BaseRule>> & {
    rules?: BaseRule[];
    groups?: BaseGroup<BaseRule>[];
  } = {},
): BaseGroup<BaseRule> {
  return {
    id: id(),
    condition: "AND",
    rules: [],
    groups: [],
    ...overrides,
  };
}

const testConfig: BuilderConfig<BaseRule, BaseGroup<BaseRule>> = {
  fields: [
    { value: "playCount", label: "Play Count", type: "number", section: "media" },
    { value: "resolution", label: "Resolution", type: "text", section: "video" },
    { value: "title", label: "Title", type: "text", section: "media" },
    { value: "year", label: "Year", type: "number", section: "media" },
    { value: "addedAt", label: "Date Added", type: "date", section: "media" },
    { value: "fileSize", label: "File Size", type: "number", section: "file" },
    { value: "genre", label: "Genre", type: "text", section: "media" },
    { value: "audioCodec", label: "Audio Codec", type: "text", section: "audio" },
    { value: "hasExternalId", label: "Has External ID", type: "boolean", section: "external" },
  ],
  operators: [
    { value: "equals", label: "Equals", dateLabel: "Is On", types: ["number", "text", "date", "boolean"] },
    { value: "notEquals", label: "Not Equals", dateLabel: "Is Not On", types: ["number", "text", "date", "boolean"] },
    { value: "greaterThan", label: "Greater Than", types: ["number"] },
    { value: "greaterThanOrEqual", label: ">=", types: ["number"] },
    { value: "lessThan", label: "Less Than", types: ["number"] },
    { value: "lessThanOrEqual", label: "<=", types: ["number"] },
    { value: "contains", label: "Contains", types: ["text"] },
    { value: "notContains", label: "Not Contains", types: ["text"] },
    { value: "matchesWildcard", label: "Matches Wildcard", types: ["text"] },
    { value: "notMatchesWildcard", label: "Not Matches Wildcard", types: ["text"] },
    { value: "before", label: "Is Before", types: ["date"] },
    { value: "after", label: "Is After", types: ["date"] },
    { value: "inLastDays", label: "In Last X Days", types: ["date"] },
    { value: "notInLastDays", label: "More Than X Days Ago", types: ["date"] },
    { value: "isNull", label: "Is Empty", types: ["number", "text", "date"] },
    { value: "isNotNull", label: "Is Not Empty", types: ["number", "text", "date"] },
  ],
  sections: [
    { key: "media", label: "Media" },
    { key: "video", label: "Video" },
    { key: "audio", label: "Audio" },
    { key: "file", label: "File" },
    { key: "external", label: "External" },
  ],
  createRule: () => makeRule(),
  createGroup: () => makeGroup(),
  isFieldDisabled: () => false,
  getDisabledTooltip: () => null,
  isValuelessOperator: (op) => op === "isNull" || op === "isNotNull",
};

/** Extract just the type and text from lines for easy assertion */
function simplify(lines: PseudocodeLine[]): Array<{ type: string; text: string; depth: number }> {
  return lines.map((l) => ({ type: l.type, text: l.text, depth: l.depth }));
}

/** Extract just connectors for quick checks */
function connectors(lines: PseudocodeLine[]): string[] {
  return lines.filter((l) => l.type === "connector").map((l) => l.text);
}

/** Extract non-connector, non-bracket lines (just rules) */
function ruleTexts(lines: PseudocodeLine[]): string[] {
  return lines.filter((l) => l.type === "rule").map((l) => l.text);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("generatePseudocode", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  // ── Basic structure ──────────────────────────────────────────────────────

  describe("basic structure", () => {
    it("returns empty array for empty groups", () => {
      const result = generatePseudocode([], testConfig);
      expect(result).toEqual([]);
    });

    it("renders a single group with one rule", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "equals", value: "0" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const s = simplify(lines);

      expect(s[0]).toEqual({ type: "group-start", text: "WHERE (", depth: 0 });
      expect(s[1]).toEqual({ type: "rule", text: 'Play Count = 0', depth: 1 });
      expect(s[2]).toEqual({ type: "group-end", text: ")", depth: 0 });
      expect(s).toHaveLength(3);
    });

    it("renders a named group", () => {
      const groups = [makeGroup({
        name: "Quality Rules",
        rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(lines[0].text).toBe('WHERE (Quality Rules: ');
    });
  });

  // ── Rule connectors (the core AND/OR logic) ─────────────────────────────

  describe("rule connectors within a group", () => {
    it("uses the CURRENT rule's condition as the connector (not previous)", () => {
      // Rule 1 has condition "OR", Rule 2 has condition "AND"
      // The connector between them should be Rule 2's condition: "AND"
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" }),
          makeRule({ field: "resolution", operator: "equals", value: "4K", condition: "AND" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["AND"]);
    });

    it("first rule's condition is not used as a connector", () => {
      // First rule has condition "OR" but it shouldn't appear as a connector
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual([]);
    });

    it("three rules: connectors use rule[1] and rule[2] conditions", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" }),
          makeRule({ field: "resolution", operator: "equals", value: "4K", condition: "AND" }),
          makeRule({ field: "year", operator: "greaterThan", value: "2020", condition: "OR" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["AND", "OR"]);
    });

    it("all AND conditions", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ condition: "AND" }),
          makeRule({ condition: "AND" }),
          makeRule({ condition: "AND" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["AND", "AND"]);
    });

    it("all OR conditions", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ condition: "OR" }),
          makeRule({ condition: "OR" }),
          makeRule({ condition: "OR" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["OR", "OR"]);
    });

    it("alternating AND/OR conditions", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ condition: "AND" }),  // ignored (first)
          makeRule({ condition: "OR" }),   // connector = OR
          makeRule({ condition: "AND" }),  // connector = AND
          makeRule({ condition: "OR" }),   // connector = OR
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["OR", "AND", "OR"]);
    });
  });

  // ── Sub-group connectors ─────────────────────────────────────────────────

  describe("sub-group connectors", () => {
    it("sub-group after rules uses the sub-group's condition", () => {
      // Rule has condition "OR", sub-group has condition "AND"
      // Connector between rule and sub-group should be sub-group's condition: "AND"
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" }),
        ],
        groups: [
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      // Connectors: between rule and sub-group
      expect(connectors(lines)).toEqual(["AND"]);
    });

    it("sub-group after rules uses OR when sub-group condition is OR", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" }),
        ],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(connectors(lines)).toEqual(["OR"]);
    });

    it("only sub-groups (no rules): first sub-group's condition is not used", () => {
      const groups = [makeGroup({
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "playCount", operator: "equals", value: "0" })],
          }),
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      // Only connector between the two sub-groups — uses second sub-group's condition
      const outerConnectors = lines.filter(
        (l) => l.type === "connector" && l.depth === 1,
      );
      expect(outerConnectors).toHaveLength(1);
      expect(outerConnectors[0].text).toBe("AND");
    });

    it("two sub-groups after rules", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" }),
        ],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "year", operator: "greaterThan", value: "2020" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      // Connectors at depth 1: rule→subgroup1 (OR), subgroup1→subgroup2 (AND)
      const depth1Connectors = lines.filter(
        (l) => l.type === "connector" && l.depth === 1,
      );
      expect(depth1Connectors.map((c) => c.text)).toEqual(["OR", "AND"]);
    });

    it("mixed rules and sub-groups preserve correct conditions", () => {
      // 2 rules (conditions: ignored, OR) + 2 sub-groups (conditions: AND, OR)
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" }),
          makeRule({ field: "title", operator: "contains", value: "test", condition: "OR" }),
        ],
        groups: [
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "year", operator: "lessThan", value: "2020" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      // Depth 1 connectors: rule1→rule2 (OR), rule2→sub1 (AND), sub1→sub2 (OR)
      const depth1Connectors = lines.filter(
        (l) => l.type === "connector" && l.depth === 1,
      );
      expect(depth1Connectors.map((c) => c.text)).toEqual(["OR", "AND", "OR"]);
    });
  });

  // ── Top-level group connectors ───────────────────────────────────────────

  describe("top-level group connectors", () => {
    it("uses the second group's condition for the connector", () => {
      const groups = [
        makeGroup({
          condition: "OR",  // ignored (first group)
          rules: [makeRule()],
        }),
        makeGroup({
          condition: "AND",
          rules: [makeRule()],
        }),
      ];
      const lines = generatePseudocode(groups, testConfig);
      // Connector between top-level groups at depth 0
      const topConnectors = lines.filter(
        (l) => l.type === "connector" && l.depth === 0,
      );
      expect(topConnectors).toHaveLength(1);
      expect(topConnectors[0].text).toBe("AND");
    });

    it("three top-level groups use correct conditions", () => {
      const groups = [
        makeGroup({ condition: "AND", rules: [makeRule()] }),
        makeGroup({ condition: "OR", rules: [makeRule()] }),
        makeGroup({ condition: "AND", rules: [makeRule()] }),
      ];
      const lines = generatePseudocode(groups, testConfig);
      const topConnectors = lines.filter(
        (l) => l.type === "connector" && l.depth === 0,
      );
      expect(topConnectors.map((c) => c.text)).toEqual(["OR", "AND"]);
    });

    it("WHERE only appears on first top-level group", () => {
      const groups = [
        makeGroup({ rules: [makeRule()] }),
        makeGroup({ rules: [makeRule()] }),
      ];
      const lines = generatePseudocode(groups, testConfig);
      const groupStarts = lines.filter((l) => l.type === "group-start" && l.depth === 0);
      expect(groupStarts[0].text).toContain("WHERE");
      expect(groupStarts[1].text).not.toContain("WHERE");
    });
  });

  // ── Deeply nested groups ─────────────────────────────────────────────────

  describe("deeply nested groups", () => {
    it("three levels deep: connectors use correct conditions", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" })],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K", condition: "AND" })],
            groups: [
              makeGroup({
                condition: "AND",
                rules: [makeRule({ field: "year", operator: "greaterThan", value: "2020" })],
              }),
            ],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);

      // depth 1: rule→sub-group connector = OR (sub-group's condition)
      const d1 = lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(d1.map((c) => c.text)).toEqual(["OR"]);

      // depth 2: rule→sub-sub-group connector = AND (sub-sub-group's condition)
      const d2 = lines.filter((l) => l.type === "connector" && l.depth === 2);
      expect(d2.map((c) => c.text)).toEqual(["AND"]);
    });

    it("sub-group with multiple rules and nested sub-group", () => {
      const groups = [makeGroup({
        rules: [makeRule({ condition: "AND" })],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [
              makeRule({ field: "title", operator: "contains", value: "a", condition: "AND" }),
              makeRule({ field: "genre", operator: "contains", value: "b", condition: "OR" }),
              makeRule({ field: "audioCodec", operator: "equals", value: "aac", condition: "AND" }),
            ],
            groups: [
              makeGroup({
                condition: "AND",
                rules: [makeRule({ field: "year", operator: "lessThan", value: "2000" })],
              }),
            ],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);

      // depth 1: rule→sub-group = OR
      const d1 = lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(d1.map((c) => c.text)).toEqual(["OR"]);

      // depth 2: rule2.condition=OR, rule3.condition=AND, sub-group.condition=AND
      const d2 = lines.filter((l) => l.type === "connector" && l.depth === 2);
      expect(d2.map((c) => c.text)).toEqual(["OR", "AND", "AND"]);
    });
  });

  // ── Disabled and negated ─────────────────────────────────────────────────

  describe("disabled and negated", () => {
    it("disabled rule is marked disabled", () => {
      const groups = [makeGroup({
        rules: [makeRule({ enabled: false })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const rule = lines.find((l) => l.type === "rule");
      expect(rule?.disabled).toBe(true);
    });

    it("disabled group marks all children disabled", () => {
      const groups = [makeGroup({
        enabled: false,
        rules: [makeRule({ enabled: true })],
        groups: [
          makeGroup({
            rules: [makeRule()],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      for (const line of lines) {
        expect(line.disabled).toBe(true);
      }
    });

    it("enabled rule in enabled group is not disabled", () => {
      const groups = [makeGroup({
        rules: [makeRule()],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const rule = lines.find((l) => l.type === "rule");
      expect(rule?.disabled).toBe(false);
    });

    it("negated rule has NOT prefix", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "resolution", operator: "equals", value: "4K", negate: true })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const rule = lines.find((l) => l.type === "rule");
      expect(rule?.text).toBe('NOT Resolution = "4K"');
      expect(rule?.negated).toBe(true);
    });

    it("non-negated rule has no NOT prefix", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "resolution", operator: "equals", value: "4K", negate: false })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const rule = lines.find((l) => l.type === "rule");
      expect(rule?.text).toBe('Resolution = "4K"');
      expect(rule?.negated).toBe(false);
    });
  });

  // ── Operators and value formatting ───────────────────────────────────────

  describe("operator display and value formatting", () => {
    it("number field shows unquoted value", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "greaterThan", value: "5" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Play Count > 5"]);
    });

    it("text field shows quoted value", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "title", operator: "contains", value: "test" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(['Title contains "test"']);
    });

    it("inLastDays shows days suffix", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "addedAt", operator: "inLastDays", value: "30" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Date Added in last 30 days"]);
    });

    it("notInLastDays shows days suffix", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "addedAt", operator: "notInLastDays", value: "90" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Date Added > ago 90 days"]);
    });

    it("isNull shows no value", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "title", operator: "isNull", value: "" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Title is empty"]);
    });

    it("isNotNull shows no value", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "title", operator: "isNotNull", value: "" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Title is not empty"]);
    });

    it("all comparison operators display correctly", () => {
      const ops = [
        { op: "equals", expected: "=" },
        { op: "notEquals", expected: "!=" },
        { op: "greaterThan", expected: ">" },
        { op: "greaterThanOrEqual", expected: ">=" },
        { op: "lessThan", expected: "<" },
        { op: "lessThanOrEqual", expected: "<=" },
      ];
      for (const { op, expected } of ops) {
        const groups = [makeGroup({
          rules: [makeRule({ field: "playCount", operator: op, value: "5" })],
        })];
        const lines = generatePseudocode(groups, testConfig);
        expect(ruleTexts(lines)).toEqual([`Play Count ${expected} 5`]);
      }
    });

    it("text operators display correctly", () => {
      const ops = [
        { op: "contains", expected: "contains" },
        { op: "notContains", expected: "not contains" },
        { op: "matchesWildcard", expected: "matches" },
        { op: "notMatchesWildcard", expected: "not matches" },
      ];
      for (const { op, expected } of ops) {
        const groups = [makeGroup({
          rules: [makeRule({ field: "title", operator: op, value: "test" })],
        })];
        const lines = generatePseudocode(groups, testConfig);
        expect(ruleTexts(lines)).toEqual([`Title ${expected} "test"`]);
      }
    });

    it("date operators display correctly", () => {
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "addedAt", operator: "before", value: "2024-01-01", condition: "AND" }),
          makeRule({ field: "addedAt", operator: "after", value: "2023-01-01", condition: "AND" }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual([
        'Date Added before "2024-01-01"',
        'Date Added after "2023-01-01"',
      ]);
    });

    it("unknown field falls back to raw field name", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "unknownField", operator: "equals", value: "x" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(['unknownField = "x"']);
    });

    it("unknown operator falls back to raw operator name", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "customOp", value: "5" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      expect(ruleTexts(lines)).toEqual(["Play Count customOp 5"]);
    });
  });

  // ── Complex scenarios matching engine evaluation ─────────────────────────

  describe("complex scenarios matching engine evaluation order", () => {
    it("engine order: rules first, then sub-groups (validates ordering)", () => {
      // Engine processes: rule1, rule2, subgroup1, subgroup2
      // Connectors: rule1→rule2 (rule2.condition), rule2→sub1 (sub1.condition), sub1→sub2 (sub2.condition)
      const groups = [makeGroup({
        rules: [
          makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" }),
          makeRule({ field: "resolution", operator: "equals", value: "4K", condition: "AND" }),
        ],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "title", operator: "contains", value: "a" })],
          }),
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "year", operator: "greaterThan", value: "2020" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);

      // Verify the complete structure
      const d1 = lines.filter((l) => l.depth === 1);
      const types = d1.map((l) => `${l.type}:${l.text}`);
      expect(types).toEqual([
        "eval-open:(", // outermost eval group
        "eval-open:(", // innermost eval group
        "rule:Play Count = 0",
        "connector:AND",
        'rule:Resolution = "4K"',
        "eval-close:)", // close innermost after item 1
        "connector:OR",
        "group-start:(",
        // inner rule at depth 2
        "group-end:)",
        "eval-close:)", // close outermost after item 2
        "connector:AND",
        "group-start:(",
        // inner rule at depth 2
        "group-end:)",
      ]);
    });

    it("matches engine: single rule + single sub-group with OR", () => {
      // Engine: items = [rule, subgroup], connector at index 1 = subgroup.condition = "OR"
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" })],
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const d1Connectors = lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(d1Connectors).toHaveLength(1);
      expect(d1Connectors[0].text).toBe("OR");
    });

    it("matches engine: single rule + single sub-group with AND", () => {
      const groups = [makeGroup({
        rules: [makeRule({ field: "playCount", operator: "equals", value: "0", condition: "OR" })],
        groups: [
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const d1Connectors = lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(d1Connectors).toHaveLength(1);
      // Should be AND (sub-group's condition), NOT OR (rule's condition)
      expect(d1Connectors[0].text).toBe("AND");
    });

    it("two top-level groups with sub-groups — full tree", () => {
      const groups = [
        makeGroup({
          condition: "AND",
          rules: [
            makeRule({ field: "playCount", operator: "equals", value: "0", condition: "AND" }),
            makeRule({ field: "resolution", operator: "equals", value: "4K", condition: "OR" }),
          ],
          groups: [
            makeGroup({
              condition: "AND",
              name: "Audio",
              rules: [makeRule({ field: "audioCodec", operator: "equals", value: "aac" })],
            }),
          ],
        }),
        makeGroup({
          condition: "OR",
          rules: [
            makeRule({ field: "year", operator: "lessThan", value: "2020", condition: "AND" }),
          ],
          groups: [
            makeGroup({
              condition: "OR",
              rules: [makeRule({ field: "fileSize", operator: "greaterThan", value: "50" })],
            }),
          ],
        }),
      ];
      const lines = generatePseudocode(groups, testConfig);

      // Top-level connector: OR (second group's condition)
      const topConnectors = lines.filter((l) => l.type === "connector" && l.depth === 0);
      expect(topConnectors.map((c) => c.text)).toEqual(["OR"]);

      // Group 1 depth-1 connectors: rule1→rule2 (OR), rule2→subgroup (AND)
      const g1Lines = lines.slice(
        lines.findIndex((l) => l.type === "group-start" && l.depth === 0),
        lines.findIndex((l) => l.type === "group-end" && l.depth === 0) + 1,
      );
      const g1d1Connectors = g1Lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(g1d1Connectors.map((c) => c.text)).toEqual(["OR", "AND"]);

      // Named sub-group shows name
      const audioStart = lines.find((l) => l.text.includes("Audio"));
      expect(audioStart).toBeDefined();
      expect(audioStart?.text).toBe("(Audio: ");
    });

    it("only sub-groups in a group (no rules)", () => {
      const groups = [makeGroup({
        groups: [
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "playCount", operator: "equals", value: "0" })],
          }),
          makeGroup({
            condition: "AND",
            rules: [makeRule({ field: "resolution", operator: "equals", value: "4K" })],
          }),
          makeGroup({
            condition: "OR",
            rules: [makeRule({ field: "year", operator: "greaterThan", value: "2020" })],
          }),
        ],
      })];
      const lines = generatePseudocode(groups, testConfig);

      // Connectors at depth 1: sub1→sub2 (AND), sub2→sub3 (OR)
      // First sub-group's condition (OR) is ignored
      const d1Connectors = lines.filter((l) => l.type === "connector" && l.depth === 1);
      expect(d1Connectors.map((c) => c.text)).toEqual(["AND", "OR"]);
    });
  });

  // ── Indentation / depth ──────────────────────────────────────────────────

  describe("indentation", () => {
    it("top-level group at depth 0, rules at depth 1", () => {
      const groups = [makeGroup({ rules: [makeRule()] })];
      const lines = generatePseudocode(groups, testConfig);
      expect(lines[0].depth).toBe(0); // group-start
      expect(lines[1].depth).toBe(1); // rule
      expect(lines[2].depth).toBe(0); // group-end
    });

    it("sub-group at depth 1, its rules at depth 2", () => {
      const groups = [makeGroup({
        groups: [makeGroup({ rules: [makeRule()] })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const subStart = lines.find((l) => l.type === "group-start" && l.depth === 1);
      const subRule = lines.find((l) => l.type === "rule" && l.depth === 2);
      const subEnd = lines.find((l) => l.type === "group-end" && l.depth === 1);
      expect(subStart).toBeDefined();
      expect(subRule).toBeDefined();
      expect(subEnd).toBeDefined();
    });

    it("connectors at same depth as sibling items", () => {
      const groups = [makeGroup({
        rules: [makeRule({ condition: "AND" }), makeRule({ condition: "OR" })],
      })];
      const lines = generatePseudocode(groups, testConfig);
      const connector = lines.find((l) => l.type === "connector");
      expect(connector?.depth).toBe(1);
    });
  });

  // ── Unique IDs ───────────────────────────────────────────────────────────

  describe("unique IDs", () => {
    it("all lines have unique IDs", () => {
      const groups = [
        makeGroup({
          rules: [makeRule(), makeRule()],
          groups: [makeGroup({ rules: [makeRule()] })],
        }),
        makeGroup({ rules: [makeRule()] }),
      ];
      const lines = generatePseudocode(groups, testConfig);
      const ids = lines.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ── Rule IDs ──────────────────────────────────────────────────────────────

  describe("ruleId mapping", () => {
    it("rule lines include the original rule's id", () => {
      const rule1 = makeRule({ field: "playCount", operator: "equals", value: "0" });
      const rule2 = makeRule({ field: "resolution", operator: "equals", value: "4K" });
      const groups = [makeGroup({ rules: [rule1, rule2] })];
      const lines = generatePseudocode(groups, testConfig);

      const ruleLines = lines.filter((l) => l.type === "rule");
      expect(ruleLines).toHaveLength(2);
      expect(ruleLines[0].ruleId).toBe(rule1.id);
      expect(ruleLines[1].ruleId).toBe(rule2.id);
    });

    it("non-rule lines do not have ruleId", () => {
      const groups = [makeGroup({
        rules: [makeRule(), makeRule()],
      })];
      const lines = generatePseudocode(groups, testConfig);

      const nonRuleLines = lines.filter((l) => l.type !== "rule");
      for (const line of nonRuleLines) {
        expect(line.ruleId).toBeUndefined();
      }
    });

    it("nested sub-group rules also have correct ruleId", () => {
      const innerRule = makeRule({ field: "year", operator: "greaterThan", value: "2020" });
      const groups = [makeGroup({
        rules: [makeRule()],
        groups: [makeGroup({ rules: [innerRule] })],
      })];
      const lines = generatePseudocode(groups, testConfig);

      const ruleLines = lines.filter((l) => l.type === "rule");
      expect(ruleLines).toHaveLength(2);
      expect(ruleLines[1].ruleId).toBe(innerRule.id);
    });

    it("connectors, group-start, and group-end never have ruleId", () => {
      const groups = [
        makeGroup({
          rules: [makeRule(), makeRule()],
          groups: [makeGroup({ rules: [makeRule()] })],
        }),
        makeGroup({ rules: [makeRule()] }),
      ];
      const lines = generatePseudocode(groups, testConfig);

      for (const line of lines) {
        if (line.type === "connector" || line.type === "group-start" || line.type === "group-end") {
          expect(line.ruleId).toBeUndefined();
        }
      }
    });
  });
});
