import { describe, it, expect } from "vitest";
import { matchNameListField } from "@/lib/conditions/name-list-eval";

describe("matchNameListField", () => {
  const tags = ["Keep", "4K-UHD", "anime"];

  it("treats equals/notEquals as case-insensitive exact membership", () => {
    expect(matchNameListField(tags, "equals", "keep")).toBe(true);
    expect(matchNameListField(tags, "equals", "KEEP")).toBe(true);
    expect(matchNameListField(tags, "equals", "kee")).toBe(false);
    expect(matchNameListField(tags, "notEquals", "keep")).toBe(false);
    expect(matchNameListField(tags, "notEquals", "missing")).toBe(true);
  });

  it("treats contains/notContains as pipe-separated multi-select membership", () => {
    expect(matchNameListField(tags, "contains", "missing|anime")).toBe(true);
    expect(matchNameListField(tags, "contains", "missing|other")).toBe(false);
    expect(matchNameListField(tags, "notContains", "missing|anime")).toBe(false);
    expect(matchNameListField(tags, "notContains", "missing|other")).toBe(true);
    // Membership, not substring: "kee" must not match the tag "Keep".
    expect(matchNameListField(tags, "contains", "kee")).toBe(false);
  });

  it("supports wildcards, case-insensitively on both sides", () => {
    expect(matchNameListField(tags, "matchesWildcard", "*KEEP*")).toBe(true);
    expect(matchNameListField(tags, "matchesWildcard", "4k-*")).toBe(true);
    expect(matchNameListField(tags, "matchesWildcard", "*zzz*")).toBe(false);
    expect(matchNameListField(tags, "notMatchesWildcard", "*keep*")).toBe(false);
    expect(matchNameListField(tags, "notMatchesWildcard", "*zzz*")).toBe(true);
  });

  it("reads isNull/isNotNull as list emptiness", () => {
    expect(matchNameListField([], "isNull", "")).toBe(true);
    expect(matchNameListField(tags, "isNull", "")).toBe(false);
    expect(matchNameListField([], "isNotNull", "")).toBe(false);
    expect(matchNameListField(tags, "isNotNull", "")).toBe(true);
  });

  it("normalizes a null/undefined/non-array list to empty rather than throwing", () => {
    for (const input of [null, undefined, "not-an-array", 42, {}]) {
      expect(matchNameListField(input, "isNull", "")).toBe(true);
      expect(matchNameListField(input, "equals", "keep")).toBe(false);
      expect(matchNameListField(input, "notEquals", "keep")).toBe(true);
    }
  });

  it("returns null for an unknown operator so the caller can bypass negate", () => {
    // A `false` here would flip to match-all under `negate`, sweeping the library.
    expect(matchNameListField(tags, "greaterThan", "1")).toBeNull();
    expect(matchNameListField(tags, "between", "1,2")).toBeNull();
  });
});
