import { describe, it, expect } from "vitest";
import { validateAllRules } from "@/components/builder/tree-utils";
import type { BaseRule, BaseGroup } from "@/components/builder/types";

// getFieldType used by the lifecycle/query builders: Year is a number field.
const getFieldType = (field: string): "number" | "text" | "date" | "boolean" =>
  field === "year" || field === "playCount" ? "number" : field === "addedAt" ? "date" : "text";
const isValueless = (op: string) => op === "isNull" || op === "isNotNull";

function group(rules: Partial<BaseRule>[]): BaseGroup {
  return {
    id: "g",
    condition: "AND",
    rules: rules.map((r, i) => ({
      id: `r${i}`,
      field: "year",
      operator: "between",
      value: "",
      condition: "AND",
      ...r,
    })) as BaseRule[],
    groups: [],
  };
}

describe("validateAllRules — between operator", () => {
  it("accepts a valid numeric between pair", () => {
    expect(validateAllRules([group([{ value: "2000,2010" }])], getFieldType, isValueless)).toBe(true);
  });

  it("rejects a between pair with min > max", () => {
    expect(validateAllRules([group([{ value: "2010,2000" }])], getFieldType, isValueless)).toBe(false);
  });

  it("rejects a between value with only one part", () => {
    expect(validateAllRules([group([{ value: "2000" }])], getFieldType, isValueless)).toBe(false);
  });

  it("rejects a between pair with a non-numeric half", () => {
    expect(validateAllRules([group([{ value: "2000,abc" }])], getFieldType, isValueless)).toBe(false);
  });

  it("accepts a valid date between pair", () => {
    expect(
      validateAllRules(
        [group([{ field: "addedAt", value: "2020-01-01,2021-01-01" }])],
        getFieldType,
        isValueless,
      ),
    ).toBe(true);
  });

  it("does not falsely reject — regression: numeric between previously disabled all actions", () => {
    // The old scalar Number("2000,2010") => NaN path returned false here.
    expect(validateAllRules([group([{ field: "playCount", value: "1,5" }])], getFieldType, isValueless)).toBe(true);
  });
});
