import { describe, it, expect } from "vitest";
import type { ConditionGroup } from "@/lib/conditions";
import {
  findIncompatibleRules,
  dropIncompatibleRules,
} from "@/components/builder/library-type-validity";

function group(id: string, rules: { field: string; id?: string }[], subGroups: ConditionGroup[] = []): ConditionGroup {
  return {
    id,
    condition: "AND",
    rules: rules.map((r, i) => ({
      id: r.id ?? `${id}-r${i}`,
      field: r.field,
      operator: "equals",
      value: "x",
      condition: "AND",
    })),
    groups: subGroups,
  };
}

describe("findIncompatibleRules", () => {
  it("flags Arr movie-specific fields as incompatible for MUSIC", () => {
    const groups = [group("g1", [{ field: "arrTmdbRating" }, { field: "title" }])];
    const out = findIncompatibleRules(groups, "MUSIC");
    expect(out.map((r) => r.field)).toEqual(["arrTmdbRating"]);
    expect(out[0].reason).toBe("invalidForLibraryType");
    expect(out[0].fieldLabel).toBe("TMDB Rating");
  });

  it("flags series-aggregate fields when target is MOVIE", () => {
    const groups = [group("g1", [{ field: "availableEpisodeCount" }, { field: "title" }])];
    const out = findIncompatibleRules(groups, "MOVIE");
    expect(out.map((r) => r.field)).toEqual(["availableEpisodeCount"]);
    // invalidForLibraryType is checked before isSeriesAggregate, so series fields with
    // invalidForLibraryType: ["MOVIE", "MUSIC"] report as invalidForLibraryType.
    expect(out[0].reason).toBe("invalidForLibraryType");
  });

  it("allows series-aggregate fields for SERIES", () => {
    const groups = [group("g1", [{ field: "availableEpisodeCount" }])];
    expect(findIncompatibleRules(groups, "SERIES")).toEqual([]);
  });

  it("recurses into sub-groups", () => {
    const groups = [
      group("g1", [{ field: "title" }], [
        group("g2", [{ field: "arrTmdbRating", id: "deep" }]),
      ]),
    ];
    const out = findIncompatibleRules(groups, "MUSIC");
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("deep");
    expect(out[0].groupId).toBe("g2");
  });

  it("returns empty for unknown fields", () => {
    const groups = [group("g1", [{ field: "noSuchField" }])];
    expect(findIncompatibleRules(groups, "MOVIE")).toEqual([]);
  });
});

describe("dropIncompatibleRules", () => {
  it("removes incompatible rules and keeps compatible ones", () => {
    const groups = [
      group("g1", [{ field: "title" }, { field: "arrTmdbRating" }]),
    ];
    const out = dropIncompatibleRules(groups, "MUSIC");
    expect(out).toHaveLength(1);
    expect(out[0].rules.map((r) => r.field)).toEqual(["title"]);
  });

  it("removes groups that become empty after pruning", () => {
    const groups = [
      group("g1", [{ field: "arrTmdbRating" }]),
      group("g2", [{ field: "title" }]),
    ];
    const out = dropIncompatibleRules(groups, "MUSIC");
    expect(out.map((g) => g.id)).toEqual(["g2"]);
  });

  it("preserves nested-group structure when only some rules are dropped", () => {
    const groups = [
      group(
        "g1",
        [{ field: "title" }, { field: "arrTmdbRating" }],
        [group("g2", [{ field: "year" }, { field: "arrRtCriticRating" }])],
      ),
    ];
    const out = dropIncompatibleRules(groups, "MUSIC");
    expect(out).toHaveLength(1);
    expect(out[0].rules.map((r) => r.field)).toEqual(["title"]);
    expect(out[0].groups).toHaveLength(1);
    expect(out[0].groups[0].rules.map((r) => r.field)).toEqual(["year"]);
  });

  it("removes a parent group when all rules and sub-groups become empty", () => {
    const groups = [
      group(
        "g1",
        [{ field: "arrTmdbRating" }],
        [group("g2", [{ field: "availableEpisodeCount" }])],
      ),
    ];
    const out = dropIncompatibleRules(groups, "MUSIC");
    expect(out).toEqual([]);
  });

  it("does not mutate the input tree", () => {
    const groups = [group("g1", [{ field: "title" }, { field: "arrTmdbRating" }])];
    const snapshot = JSON.stringify(groups);
    dropIncompatibleRules(groups, "MUSIC");
    expect(JSON.stringify(groups)).toBe(snapshot);
  });
});
