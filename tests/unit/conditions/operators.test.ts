import { describe, it, expect } from "vitest";
import { CONDITION_OPERATORS, isValuelessOperator } from "@/lib/conditions/operators";
import { CONDITION_SECTIONS } from "@/lib/conditions/sections";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import { MB_IN_BYTES, DURATION_MS_PER_MIN, RESOLUTION_DB_VALUES } from "@/lib/conditions/constants";
import { wildcardToRegex } from "@/lib/conditions/wildcard";

describe("CONDITION_OPERATORS", () => {
  it("has unique values", () => {
    const values = CONDITION_OPERATORS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("gives every operator a label and at least one field type", () => {
    for (const op of CONDITION_OPERATORS) {
      expect(op.label.length).toBeGreaterThan(0);
      expect(op.types.length).toBeGreaterThan(0);
    }
  });

  it("offers every non-boolean field type at least an equality operator", () => {
    for (const t of ["number", "text", "date", "boolean"] as const) {
      expect(CONDITION_OPERATORS.some((o) => o.value === "equals" && o.types.includes(t))).toBe(true);
    }
  });

  it("restricts wildcard and contains operators to text", () => {
    for (const v of ["contains", "notContains", "matchesWildcard", "notMatchesWildcard"]) {
      expect(CONDITION_OPERATORS.find((o) => o.value === v)?.types).toEqual(["text"]);
    }
  });

  it("gives equals/notEquals a date-specific label", () => {
    expect(CONDITION_OPERATORS.find((o) => o.value === "equals")?.dateLabel).toBe("Is On");
    expect(CONDITION_OPERATORS.find((o) => o.value === "notEquals")?.dateLabel).toBe("Is Not On");
  });
});

describe("isValuelessOperator", () => {
  it("is true only for isNull/isNotNull", () => {
    expect(isValuelessOperator("isNull")).toBe(true);
    expect(isValuelessOperator("isNotNull")).toBe(true);
    for (const op of CONDITION_OPERATORS.map((o) => o.value)) {
      if (op !== "isNull" && op !== "isNotNull") expect(isValuelessOperator(op)).toBe(false);
    }
    expect(isValuelessOperator("")).toBe(false);
  });
});

describe("CONDITION_SECTIONS", () => {
  it("has unique keys", () => {
    const keys = CONDITION_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the section of every registered field", () => {
    const keys = new Set<string>(CONDITION_SECTIONS.map((s) => s.key));
    for (const field of CONDITION_FIELDS) {
      expect(keys.has(field.section), `${field.value} → ${field.section}`).toBe(true);
    }
  });
});

describe("condition constants", () => {
  it("defines unit conversions", () => {
    expect(MB_IN_BYTES).toBe(1_048_576);
    expect(DURATION_MS_PER_MIN).toBe(60_000);
  });

  it("maps each resolution label to lower-case raw spellings with no overlap", () => {
    const seen = new Set<string>();
    for (const values of Object.values(RESOLUTION_DB_VALUES)) {
      for (const v of values) {
        expect(v).toBe(v.toLowerCase());
        expect(seen.has(v)).toBe(false);
        seen.add(v);
      }
    }
    expect(Object.keys(RESOLUTION_DB_VALUES)).toEqual(["4K", "1080P", "720P", "480P", "SD"]);
  });
});

describe("wildcardToRegex", () => {
  it("anchors the pattern and matches case-insensitively", () => {
    const re = wildcardToRegex("star*");
    expect(re.test("Star Wars")).toBe(true);
    expect(re.test("A Star Is Born")).toBe(false);
  });

  it("treats ? as exactly one character", () => {
    const re = wildcardToRegex("S0?E01");
    expect(re.test("s01e01")).toBe(true);
    expect(re.test("S0E01")).toBe(false);
    expect(re.test("S011E01")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    expect(wildcardToRegex("a.b").test("axb")).toBe(false);
    expect(wildcardToRegex("a.b").test("a.b")).toBe(true);
    expect(wildcardToRegex("(1+1)").test("(1+1)")).toBe(true);
    expect(wildcardToRegex("[x]").test("x")).toBe(false);
    expect(wildcardToRegex("$^|\\{}").test("$^|\\{}")).toBe(true);
  });

  it("matches everything with a lone star and only empty with an empty pattern", () => {
    expect(wildcardToRegex("*").test("")).toBe(true);
    expect(wildcardToRegex("*").test("anything")).toBe(true);
    expect(wildcardToRegex("").test("")).toBe(true);
    expect(wildcardToRegex("").test("x")).toBe(false);
  });
});
