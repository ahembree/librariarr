import { describe, it, expect } from "vitest";
import { ruleSetCreateSchema, rulePreviewSchema, ruleSetUpdateSchema } from "@/lib/validation";

// Helper to test rule structure validation via the schema's refine
function validateRules(rules: unknown[]) {
  const result = rulePreviewSchema.safeParse({
    rules,
    type: "MOVIE",
    serverIds: ["server-1"],
  });
  return result;
}

describe("Rule structure validation", () => {
  // ── Valid structures ──

  it("accepts valid flat rules", () => {
    const result = validateRules([
      { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts valid RuleGroup format", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "1", field: "title", operator: "contains", value: "test" },
        ],
        groups: [],
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts nested groups recursively", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "OR",
        rules: [
          { id: "1", field: "year", operator: "greaterThan", value: 2020 },
        ],
        groups: [
          {
            id: "g2",
            condition: "AND",
            rules: [
              { id: "2", field: "playCount", operator: "equals", value: 0 },
            ],
            groups: [],
          },
        ],
      },
    ]);
    expect(result.success).toBe(true);
  });

  // ── Invalid flat rules ──

  it("rejects rules without field property", () => {
    const result = validateRules([
      { id: "1", operator: "greaterThan", value: 5, condition: "AND" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects rules without operator property", () => {
    const result = validateRules([
      { id: "1", field: "playCount", value: 5, condition: "AND" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects rules with non-string field", () => {
    const result = validateRules([
      { id: "1", field: 123, operator: "greaterThan", value: 5, condition: "AND" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects rules with non-string operator", () => {
    const result = validateRules([
      { id: "1", field: "playCount", operator: true, value: 5, condition: "AND" },
    ]);
    expect(result.success).toBe(false);
  });

  // ── Invalid RuleGroup ──

  it("rejects RuleGroup without condition", () => {
    const result = validateRules([
      {
        id: "g1",
        rules: [
          { id: "1", field: "title", operator: "contains", value: "test" },
        ],
        groups: [],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects RuleGroup with invalid condition", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "XOR",
        rules: [
          { id: "1", field: "title", operator: "contains", value: "test" },
        ],
        groups: [],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects RuleGroup where rules is not an array", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "AND",
        rules: "not-an-array",
        groups: [],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects RuleGroup with malformed nested rules", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "1", value: "test" }, // missing field and operator
        ],
        groups: [],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects invalid nested groups", () => {
    const result = validateRules([
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "1", field: "title", operator: "contains", value: "test" },
        ],
        groups: [
          {
            id: "g2",
            // Missing condition
            rules: [
              { id: "2", field: "year", operator: "greaterThan", value: 2020 },
            ],
            groups: [],
          },
        ],
      },
    ]);
    expect(result.success).toBe(false);
  });

  // ── Empty rules ──

  it("rejects empty rules array", () => {
    const result = validateRules([]);
    expect(result.success).toBe(false);
  });

  // ── Schema-specific checks ──

  it("ruleSetCreateSchema enforces min(1) rules", () => {
    const result = ruleSetCreateSchema.safeParse({
      name: "Test",
      type: "MOVIE",
      rules: [],
      serverIds: ["server-1"],
    });
    expect(result.success).toBe(false);
  });

  it("ruleSetUpdateSchema enforces min(1) rules when provided", () => {
    const result = ruleSetUpdateSchema.safeParse({
      rules: [],
    });
    expect(result.success).toBe(false);
  });

  it("ruleSetUpdateSchema allows omitting rules entirely", () => {
    const result = ruleSetUpdateSchema.safeParse({
      name: "Updated Name",
    });
    expect(result.success).toBe(true);
  });
});
