import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  seasonsBehindLatestOf,
  summarizeEpisodeFields,
  formatEpisodeFieldValues,
  episodeFieldValuesOf,
  latestSeasonKey,
} from "@/lib/conditions/episode-fields";
import {
  isEpisodeLevelField,
  episodeLevelValue,
  hasEpisodeLevelRules,
  hasSeasonsBehindLatestRules,
  EPISODE_LEVEL_FIELDS,
} from "@/lib/conditions/helpers";
import { ruleToWhere, UNSATISFIABLE_WHERE } from "@/lib/conditions/where-builder";
import {
  findEpisodeLevelFields,
  findFieldsInvalidForType,
  SERIES_SCOPE_EPISODE_CRITERIA_REASON,
} from "@/lib/conditions/library-type-guard";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import type { ConditionGroup } from "@/lib/conditions/types";

function tree(field: string, enabled = true): ConditionGroup[] {
  return [{
    id: "g", condition: "AND", groups: [],
    rules: [{ id: "r", field, operator: "equals", value: "1", condition: "AND", enabled }],
  }];
}

describe("per-episode field registry", () => {
  it("marks exactly Season Number, Episode Number and Seasons Behind Latest", () => {
    expect([...EPISODE_LEVEL_FIELDS].sort()).toEqual(["episodeNumber", "seasonNumber", "seasonsBehindLatest"]);
    for (const f of CONDITION_FIELDS.filter((d) => d.episodeLevel)) {
      expect(f.section).toBe("episode");
      expect(f.type).toBe("number");
      expect(f.invalidForLibraryType).toEqual(["MOVIE", "MUSIC"]);
    }
    expect(isEpisodeLevelField("seasonNumber")).toBe(true);
    expect(isEpisodeLevelField("year")).toBe(false);
  });

  it("gates on enabled rules only", () => {
    expect(hasEpisodeLevelRules(tree("episodeNumber"))).toBe(true);
    expect(hasEpisodeLevelRules(tree("episodeNumber", false))).toBe(false);
    expect(hasEpisodeLevelRules(tree("year"))).toBe(false);
    expect(hasSeasonsBehindLatestRules(tree("seasonsBehindLatest"))).toBe(true);
    expect(hasSeasonsBehindLatestRules(tree("seasonNumber"))).toBe(false);
  });
});

describe("episodeLevelValue", () => {
  it("reads the column on an episode, or a record without a type", () => {
    expect(episodeLevelValue({ type: "SERIES", seasonNumber: 3 }, "seasonNumber")).toBe(3);
    expect(episodeLevelValue({ seasonNumber: 3 }, "seasonNumber")).toBe(3);
  });

  it("reads NULL on a track's disc/track number and on a movie", () => {
    expect(episodeLevelValue({ type: "MUSIC", seasonNumber: 1 }, "seasonNumber")).toBeNull();
    expect(episodeLevelValue({ type: "MOVIE", episodeNumber: 5 }, "episodeNumber")).toBeNull();
  });
});

describe("seasonsBehindLatestOf", () => {
  it("counts season numbers back from the newest season", () => {
    expect(seasonsBehindLatestOf(5, 5)).toBe(0);
    expect(seasonsBehindLatestOf(3, 5)).toBe(2);
    expect(seasonsBehindLatestOf(1, 5)).toBe(4);
  });

  it("has no value for specials, unnumbered episodes or an unknown show", () => {
    expect(seasonsBehindLatestOf(0, 5)).toBeNull();
    expect(seasonsBehindLatestOf(null, 5)).toBeNull();
    expect(seasonsBehindLatestOf(undefined, 5)).toBeNull();
    expect(seasonsBehindLatestOf(2, undefined)).toBeNull();
  });

  it("never goes negative", () => {
    expect(seasonsBehindLatestOf(6, 5)).toBe(0);
  });

  it("keys a show within its library", () => {
    expect(latestSeasonKey("lib1", "tvdb:1")).toBe("lib1::tvdb:1");
  });
});

describe("summarizeEpisodeFields", () => {
  it("collects the distinct values, sorted, null last", () => {
    const summary = summarizeEpisodeFields([
      { seasonNumber: 2, episodeNumber: 3, seasonsBehindLatest: 1 },
      { seasonNumber: 1, episodeNumber: 3, seasonsBehindLatest: 2 },
      { seasonNumber: 0, episodeNumber: null, seasonsBehindLatest: null },
    ]);
    expect(summary).toEqual({
      seasonNumber: [0, 1, 2],
      episodeNumber: [3, null],
      seasonsBehindLatest: [1, 2, null],
    });
  });

  it("leaves Seasons Behind Latest out when the episodes do not carry it", () => {
    expect(summarizeEpisodeFields([{ seasonNumber: 1, episodeNumber: 1 }])).toEqual({
      seasonNumber: [1],
      episodeNumber: [1],
    });
  });

  it("is read back per field, only from a summarized group", () => {
    const item = { episodeFieldValues: { seasonNumber: [1, 2] } };
    expect(episodeFieldValuesOf(item, "seasonNumber")).toEqual([1, 2]);
    expect(episodeFieldValuesOf(item, "episodeNumber")).toBeUndefined();
    expect(episodeFieldValuesOf({ seasonNumber: 1 }, "seasonNumber")).toBeUndefined();
  });
});

describe("formatEpisodeFieldValues", () => {
  it("collapses runs into ranges", () => {
    expect(formatEpisodeFieldValues([1, 2, 3, 5, 7, 8])).toBe("1–3, 5, 7–8");
    expect(formatEpisodeFieldValues([4])).toBe("4");
  });

  it("names a missing value", () => {
    expect(formatEpisodeFieldValues([1, null])).toBe("1, none");
    expect(formatEpisodeFieldValues([])).toBe("none");
  });
});

describe("Phase 1 clauses", () => {
  const where = (operator: string, value: string | number, negate = false) =>
    ruleToWhere({ id: "r", field: "seasonNumber", operator, value, negate, condition: "AND" });

  it("requires an episode for a positive comparison", () => {
    expect(where("equals", "2")).toEqual({ AND: [{ type: "SERIES" }, { seasonNumber: 2 }] });
    expect(where("between", "1,3")).toEqual({ AND: [{ type: "SERIES" }, { seasonNumber: { gte: 1, lte: 3 } }] });
  });

  it("negates a positive comparison NULL-safely", () => {
    expect(where("greaterThan", "2", true)).toEqual({
      OR: [{ seasonNumber: null }, { NOT: { AND: [{ type: "SERIES" }, { seasonNumber: { gt: 2 } }] } }],
    });
  });

  it("counts every non-episode row as having no value", () => {
    expect(where("isNull", "")).toEqual({ OR: [{ seasonNumber: null }, { type: { not: "SERIES" } }] });
    expect(where("notEquals", "1")).toEqual({
      OR: [{ seasonNumber: null }, { type: { not: "SERIES" } }, { seasonNumber: { not: 1 } }],
    });
    expect(where("isNotNull", "")).toEqual({ AND: [{ type: "SERIES" }, { seasonNumber: { not: null } }] });
  });

  it("leaves Seasons Behind Latest to Phase 2", () => {
    expect(ruleToWhere({ id: "r", field: "seasonsBehindLatest", operator: "greaterThan", value: "1", condition: "AND" })).toEqual({});
  });

  it("refuses a malformed value", () => {
    expect(where("equals", "abc")).toEqual(UNSATISFIABLE_WHERE);
  });
});

describe("rule set guards", () => {
  it("finds per-episode fields anywhere in the tree, disabled ones included", () => {
    const rules = [{
      id: "g", condition: "AND", rules: [{ id: "r", field: "title", operator: "contains", value: "x", condition: "AND" }],
      groups: [{ id: "g2", condition: "AND", groups: [], rules: [
        { id: "r2", field: "episodeNumber", operator: "equals", value: "1", condition: "AND", enabled: false },
      ] }],
    }];
    expect(findEpisodeLevelFields(rules)).toEqual(["episodeNumber"]);
    expect(findEpisodeLevelFields([{ id: "r", field: "title", operator: "equals", value: "x" }])).toEqual([]);
    expect(SERIES_SCOPE_EPISODE_CRITERIA_REASON).toMatch(/series scope/);
  });

  it("is invalid for movie and music rule sets", () => {
    expect(findFieldsInvalidForType(tree("seasonsBehindLatest"), "MOVIE")).toEqual(["seasonsBehindLatest"]);
    expect(findFieldsInvalidForType(tree("seasonNumber"), "MUSIC")).toEqual(["seasonNumber"]);
    expect(findFieldsInvalidForType(tree("seasonNumber"), "SERIES")).toEqual([]);
  });
});
