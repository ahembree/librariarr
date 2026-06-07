import { describe, it, expect } from "vitest";
import {
  collectRuleFields,
  findFieldsInvalidForType,
  findFieldsInvalidForTypes,
} from "@/lib/conditions/library-type-guard";

// Minimal group/rule shapes mirroring the saved JSON structure.
const group = (rules: object[], groups: object[] = []) => ({
  id: "g",
  condition: "AND",
  rules,
  groups,
});
const rule = (field: string) => ({ id: "r", field, operator: "equals", value: "x", condition: "AND" });

describe("collectRuleFields", () => {
  it("collects fields from flat rules and nested groups", () => {
    const tree = [
      group(
        [rule("title"), rule("arrSeasonCount")],
        [group([rule("year"), rule("arrSeriesType")])],
      ),
    ];
    expect(collectRuleFields(tree).sort()).toEqual(
      ["arrSeasonCount", "arrSeriesType", "title", "year"].sort(),
    );
  });

  it("ignores non-object entries and group placeholders", () => {
    expect(collectRuleFields([null, 42, "str", group([])])).toEqual([]);
  });

  it("skips stream-query (sq*) fields' absence gracefully (they are still collected as raw field names)", () => {
    // collectRuleFields returns raw names; gating filters happen in the callers.
    expect(collectRuleFields([group([rule("sqColorPrimaries")])])).toEqual(["sqColorPrimaries"]);
  });
});

describe("findFieldsInvalidForType (single-type, lifecycle rule sets)", () => {
  it("flags series-only fields on a MOVIE rule set", () => {
    const tree = [group([rule("title"), rule("arrSeasonCount"), rule("arrSeriesType")])];
    expect(findFieldsInvalidForType(tree, "MOVIE").sort()).toEqual(
      ["arrSeasonCount", "arrSeriesType"].sort(),
    );
  });

  it("flags movie-only fields on a SERIES rule set", () => {
    const tree = [group([rule("arrQualityName"), rule("arrRuntime"), rule("title")])];
    expect(findFieldsInvalidForType(tree, "SERIES").sort()).toEqual(
      ["arrQualityName", "arrRuntime"].sort(),
    );
  });

  it("flags movie+series fields (e.g. arrTmdbRating) on a MUSIC rule set", () => {
    const tree = [group([rule("arrTmdbRating"), rule("arrOriginalLanguage")])];
    expect(findFieldsInvalidForType(tree, "MUSIC").sort()).toEqual(
      ["arrOriginalLanguage", "arrTmdbRating"].sort(),
    );
  });

  it("accepts all-type and matching-type fields", () => {
    const tree = [group([rule("title"), rule("arrStatus"), rule("arrTag"), rule("arrSeasonCount")])];
    // On SERIES, arrSeasonCount is valid; the rest are all-type.
    expect(findFieldsInvalidForType(tree, "SERIES")).toEqual([]);
  });

  it("dedupes a field repeated across groups", () => {
    const tree = [
      group([rule("arrSeasonCount")]),
      group([rule("arrSeasonCount")]),
    ];
    expect(findFieldsInvalidForType(tree, "MOVIE")).toEqual(["arrSeasonCount"]);
  });

  it("ignores unknown / stream-query fields", () => {
    const tree = [group([rule("sqColorPrimaries"), rule("totallyBogus")])];
    expect(findFieldsInvalidForType(tree, "MOVIE")).toEqual([]);
  });
});

describe("findFieldsInvalidForTypes (multi-type, queries)", () => {
  it("treats empty mediaTypes (= all) as nothing invalid", () => {
    const tree = [group([rule("arrSeasonCount"), rule("arrQualityName")])];
    expect(findFieldsInvalidForTypes(tree, [])).toEqual([]);
  });

  it("flags a field only when EVERY selected type is invalid for it", () => {
    const tree = [group([rule("arrSeasonCount")])];
    // arrSeasonCount invalid for MOVIE & MUSIC. Movie+Music => invalid.
    expect(findFieldsInvalidForTypes(tree, ["MOVIE", "MUSIC"])).toEqual(["arrSeasonCount"]);
  });

  it("keeps a field valid when at least one selected type supports it", () => {
    const tree = [group([rule("arrSeasonCount")])];
    // Series supports arrSeasonCount, so Movie+Series keeps it.
    expect(findFieldsInvalidForTypes(tree, ["MOVIE", "SERIES"])).toEqual([]);
  });

  it("flags arrOriginalLanguage only for a Music-only query", () => {
    const tree = [group([rule("arrOriginalLanguage")])];
    expect(findFieldsInvalidForTypes(tree, ["MUSIC"])).toEqual(["arrOriginalLanguage"]);
    expect(findFieldsInvalidForTypes(tree, ["MOVIE", "MUSIC"])).toEqual([]);
  });
});
