import { describe, it, expect } from "vitest";
import { actionCanScopeToEpisodes } from "@/lib/lifecycle/action-types";
import {
  ruleSetActsOnEpisodes,
  ruleSetSeasonScope,
  unmonitorsWholeSeasons,
} from "@/lib/lifecycle/episode-scope";
import { hasEnabledPerMemberCriteria, isSeasonDetermined } from "@/lib/conditions/group-scope";

type Rule = { field: string; operator?: string; value?: string; enabled?: boolean };

/** One enabled group holding `rules`. */
const groups = (rules: Rule[], extra: Record<string, unknown> = {}) => [{
  id: "g",
  condition: "AND",
  operator: "AND",
  rules: rules.map((r, i) => ({ id: `r${i}`, operator: "equals", value: "1", condition: "AND", ...r })),
  ...extra,
}];

const BEHIND = { field: "seasonsBehindLatest", operator: "greaterThan", value: "2" };
const SHOW = { field: "parentTitle", operator: "equals", value: "Severance" };
const off = (rules: unknown) => ({ type: "SERIES", seriesScope: false, rules });

describe("ruleSetActsOnEpisodes", () => {
  it.each(["UNMONITOR_SONARR", "SEARCH_SONARR"])("%s acts on episodes whenever series scope is off", (actionType) => {
    expect(ruleSetActsOnEpisodes(actionType, off(groups([SHOW])))).toBe(true);
    expect(ruleSetActsOnEpisodes(actionType, off(groups([{ field: "resolution" }])))).toBe(true);
  });

  it.each(["UNMONITOR_SONARR", "SEARCH_SONARR", "UNMONITOR_DELETE_FILES_SONARR"])(
    "%s acts on the series when series scope is on",
    (actionType) => {
      expect(ruleSetActsOnEpisodes(actionType, { type: "SERIES", seriesScope: true, rules: groups([BEHIND]) })).toBe(false);
    },
  );

  it("runs Unmonitor & Delete Files per episode only on a criterion of one episode", () => {
    const type = "UNMONITOR_DELETE_FILES_SONARR";
    for (const field of ["seasonsBehindLatest", "seasonNumber", "episodeNumber", "resolution", "playCount", "watchedByUser"]) {
      expect(ruleSetActsOnEpisodes(type, off(groups([SHOW, { field }]))), field).toBe(true);
    }
    // Criteria every episode answers alike: the whole show matches or none of
    // it, and the action keeps unmonitoring the series, as it always did.
    expect(ruleSetActsOnEpisodes(type, off(groups([SHOW, { field: "arrEnded" }, { field: "watchedEpisodePercentage" }])))).toBe(false);
    // A disabled criterion is not evaluated, so it does not count.
    expect(ruleSetActsOnEpisodes(type, off(groups([SHOW, { field: "resolution", enabled: false }])))).toBe(false);
    expect(ruleSetActsOnEpisodes(type, off(groups([SHOW, BEHIND], { enabled: false })))).toBe(false);
    // A stream query group is one file's.
    expect(ruleSetActsOnEpisodes(type, off(groups([{ field: "sqCodec" }], { streamQuery: true })))).toBe(true);
  });

  it.each(["DELETE_SONARR", "CHANGE_QUALITY_PROFILE_SONARR", "DO_NOTHING", "DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_SONARR"])(
    "%s is never episode-scoped by this flag",
    (actionType) => {
      expect(actionCanScopeToEpisodes(actionType)).toBe(false);
      expect(ruleSetActsOnEpisodes(actionType, off(groups([BEHIND])))).toBe(false);
    },
  );

  it("never applies to a non-series rule set", () => {
    expect(ruleSetActsOnEpisodes("UNMONITOR_SONARR", { type: "MOVIE", seriesScope: false, rules: [] })).toBe(false);
  });
});

describe("isSeasonDetermined", () => {
  it("is true for a season criterion beside what every episode answers alike", () => {
    expect(isSeasonDetermined(groups([BEHIND]))).toBe(true);
    expect(isSeasonDetermined(groups([SHOW, BEHIND, { field: "arrEnded" }, { field: "seasonNumber" }]))).toBe(true);
    // Nested and negated alike: each criterion is constant over a season.
    expect(isSeasonDetermined([{ ...groups([SHOW])[0], groups: groups([BEHIND], { negate: true }) }])).toBe(true);
  });

  it("is false without a season criterion, or beside a criterion of one episode", () => {
    expect(isSeasonDetermined(groups([SHOW]))).toBe(false);
    for (const field of ["episodeNumber", "resolution", "playCount", "lastPlayedAt", "watchedByUser", "title", "matchedByRuleSet"]) {
      expect(isSeasonDetermined(groups([BEHIND, { field }])), field).toBe(false);
    }
    expect(isSeasonDetermined([...groups([BEHIND]), ...groups([{ field: "sqCodec" }], { streamQuery: true })])).toBe(false);
  });

  it("reads only enabled criteria", () => {
    expect(isSeasonDetermined(groups([BEHIND, { field: "watchedByUser", enabled: false }]))).toBe(true);
    expect(isSeasonDetermined(groups([{ ...BEHIND, enabled: false }]))).toBe(false);
  });

  it("reads a legacy flat rule list", () => {
    expect(isSeasonDetermined([{ id: "a", ...BEHIND }])).toBe(true);
    expect(isSeasonDetermined([{ id: "a", ...BEHIND }, { id: "b", field: "playCount" }])).toBe(false);
  });
});

describe("hasEnabledPerMemberCriteria", () => {
  it("names a criterion of one episode, enabled", () => {
    expect(hasEnabledPerMemberCriteria("SERIES", groups([SHOW]))).toBe(false);
    expect(hasEnabledPerMemberCriteria("SERIES", groups([SHOW, BEHIND]))).toBe(true);
    expect(hasEnabledPerMemberCriteria("SERIES", groups([SHOW, { field: "playCount", enabled: false }]))).toBe(false);
  });
});

describe("season scope", () => {
  it("unmonitors whole seasons only for an Unmonitor on criteria that decide per season", () => {
    expect(unmonitorsWholeSeasons("UNMONITOR_SONARR", groups([BEHIND]))).toBe(true);
    expect(unmonitorsWholeSeasons("UNMONITOR_DELETE_FILES_SONARR", groups([BEHIND]))).toBe(true);
    expect(unmonitorsWholeSeasons("SEARCH_SONARR", groups([BEHIND]))).toBe(false);
    expect(unmonitorsWholeSeasons("DELETE_FILES_SONARR", groups([BEHIND]))).toBe(false);
    // "Unmonitor watched episodes" on an airing season must not unmonitor its unaired episodes.
    expect(unmonitorsWholeSeasons("UNMONITOR_SONARR", groups([{ field: "watchedByUser" }]))).toBe(false);
    expect(unmonitorsWholeSeasons(null, groups([BEHIND]))).toBe(false);
  });

  it("is a rule set's only with its action on the episodes", () => {
    expect(ruleSetSeasonScope("UNMONITOR_DELETE_FILES_SONARR", off(groups([BEHIND])))).toBe("matched");
    expect(ruleSetSeasonScope("UNMONITOR_SONARR", off(groups([SHOW, BEHIND])))).toBe("matched");
    expect(ruleSetSeasonScope("UNMONITOR_SONARR", off(groups([BEHIND, { field: "playCount" }])))).toBeUndefined();
    expect(ruleSetSeasonScope("UNMONITOR_SONARR", { type: "SERIES", seriesScope: true, rules: groups([BEHIND]) })).toBeUndefined();
  });
});
