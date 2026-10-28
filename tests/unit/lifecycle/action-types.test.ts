import { describe, it, expect } from "vitest";
import {
  actionCanScopeToEpisodes,
  actsOnMembers,
  ruleSetActsOnEpisodes,
  supportsSearchAfter,
  QUALITY_PROFILE_ACTION_TYPES,
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
  formatActionTypeLabel,
} from "@/lib/lifecycle/action-types";

const FILE_DELETE_TYPES = [
  "DELETE_FILES_RADARR",
  "DELETE_FILES_SONARR",
  "DELETE_FILES_LIDARR",
  "UNMONITOR_DELETE_FILES_RADARR",
  "UNMONITOR_DELETE_FILES_SONARR",
  "UNMONITOR_DELETE_FILES_LIDARR",
  "MONITOR_DELETE_FILES_RADARR",
  "MONITOR_DELETE_FILES_SONARR",
  "MONITOR_DELETE_FILES_LIDARR",
];

const NO_SEARCH_AFTER_TYPES = [
  "DELETE_RADARR",
  "DELETE_SONARR",
  "DELETE_LIDARR",
  "UNMONITOR_RADARR",
  "UNMONITOR_SONARR",
  "UNMONITOR_LIDARR",
  "SEARCH_RADARR",
  "SEARCH_SONARR",
  "SEARCH_LIDARR",
  "DO_NOTHING",
];

describe("supportsSearchAfter", () => {
  it("is true for every file-deletion action type", () => {
    for (const t of FILE_DELETE_TYPES) {
      expect(supportsSearchAfter(t)).toBe(true);
    }
  });

  it("is true for every quality-profile action type", () => {
    for (const t of QUALITY_PROFILE_ACTION_TYPES) {
      expect(supportsSearchAfter(t)).toBe(true);
    }
  });

  it("is false for full deletes, unmonitor-only, dedicated search, and DO_NOTHING", () => {
    for (const t of NO_SEARCH_AFTER_TYPES) {
      expect(supportsSearchAfter(t)).toBe(false);
    }
  });

  it("lists every dropdown action type, and nothing else, in the lists above", () => {
    // A new action type must be classified on purpose, not silently default.
    const classified = new Set([...FILE_DELETE_TYPES, ...QUALITY_PROFILE_ACTION_TYPES, ...NO_SEARCH_AFTER_TYPES]);
    const all = [...MOVIE_ACTION_TYPES, ...SERIES_ACTION_TYPES, ...MUSIC_ACTION_TYPES];
    for (const { value } of all) {
      expect(classified.has(value), value).toBe(true);
    }
    expect(new Set(all.map(({ value }) => value))).toEqual(classified);
  });
});

describe("formatActionTypeLabel", () => {
  it("resolves SEARCH_* actions to their friendly name (regression: raw enum leak)", () => {
    expect(formatActionTypeLabel("SEARCH_RADARR")).toBe("Search for New Copy (Radarr)");
    expect(formatActionTypeLabel("SEARCH_SONARR")).toBe("Search for New Copy (Sonarr)");
    expect(formatActionTypeLabel("SEARCH_LIDARR")).toBe("Search for New Copy (Lidarr)");
  });

  it("resolves every dropdown action type to a non-raw label", () => {
    const all = [...MOVIE_ACTION_TYPES, ...SERIES_ACTION_TYPES, ...MUSIC_ACTION_TYPES];
    for (const { value } of all) {
      // A friendly label never equals the raw SCREAMING_SNAKE enum value.
      expect(formatActionTypeLabel(value)).not.toBe(value);
    }
  });

  it("appends the target quality profile to CHANGE_QUALITY_PROFILE_* actions", () => {
    expect(formatActionTypeLabel("CHANGE_QUALITY_PROFILE_RADARR", 5)).toBe(
      "Change Quality Profile (Radarr) → profile #5",
    );
    // No suffix when the profile id is absent.
    expect(formatActionTypeLabel("CHANGE_QUALITY_PROFILE_RADARR")).toBe(
      "Change Quality Profile (Radarr)",
    );
    expect(formatActionTypeLabel("CHANGE_QUALITY_PROFILE_RADARR", null)).toBe(
      "Change Quality Profile (Radarr)",
    );
  });

  it("falls back to the raw value for unknown action types", () => {
    expect(formatActionTypeLabel("MYSTERY_ACTION")).toBe("MYSTERY_ACTION");
  });
});

describe("ruleSetActsOnEpisodes", () => {
  it.each(["UNMONITOR_SONARR", "SEARCH_SONARR"])("%s acts on episodes when series scope is off", (actionType) => {
    expect(ruleSetActsOnEpisodes(actionType, { type: "SERIES", seriesScope: false })).toBe(true);
  });

  it.each(["UNMONITOR_SONARR", "SEARCH_SONARR"])("%s acts on the series when series scope is on", (actionType) => {
    expect(ruleSetActsOnEpisodes(actionType, { type: "SERIES", seriesScope: true })).toBe(false);
  });

  it.each(["DELETE_SONARR", "CHANGE_QUALITY_PROFILE_SONARR", "DO_NOTHING", "DELETE_FILES_SONARR"])(
    "%s is never episode-scoped by this flag",
    (actionType) => {
      expect(actionCanScopeToEpisodes(actionType)).toBe(false);
      expect(ruleSetActsOnEpisodes(actionType, { type: "SERIES", seriesScope: false })).toBe(false);
    },
  );

  it("never applies to a non-series rule set", () => {
    expect(ruleSetActsOnEpisodes("UNMONITOR_SONARR", { type: "MOVIE", seriesScope: false })).toBe(false);
  });
});

describe("actsOnMembers", () => {
  it("is true for the file deletes whatever the scope", () => {
    expect(actsOnMembers("DELETE_FILES_SONARR")).toBe(true);
    expect(actsOnMembers("DELETE_FILES_SONARR", false)).toBe(true);
  });

  it("is true for Unmonitor and Search only when episode-scoped", () => {
    expect(actsOnMembers("UNMONITOR_SONARR", true)).toBe(true);
    expect(actsOnMembers("SEARCH_SONARR", true)).toBe(true);
    expect(actsOnMembers("UNMONITOR_SONARR", false)).toBe(false);
    expect(actsOnMembers("SEARCH_SONARR")).toBe(false);
  });

  it("is false for whole-record actions even when episode-scoped", () => {
    expect(actsOnMembers("DELETE_SONARR", true)).toBe(false);
    expect(actsOnMembers("CHANGE_QUALITY_PROFILE_SONARR", true)).toBe(false);
  });
});
