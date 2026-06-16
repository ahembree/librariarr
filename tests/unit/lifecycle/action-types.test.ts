import { describe, it, expect } from "vitest";
import {
  supportsSearchAfter,
  QUALITY_PROFILE_ACTION_TYPES,
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
  formatActionTypeLabel,
} from "@/lib/lifecycle/action-types";

describe("supportsSearchAfter", () => {
  it("is true for every file-deletion action type", () => {
    for (const t of [
      "DELETE_FILES_RADARR",
      "DELETE_FILES_SONARR",
      "DELETE_FILES_LIDARR",
      "UNMONITOR_DELETE_FILES_RADARR",
      "UNMONITOR_DELETE_FILES_SONARR",
      "UNMONITOR_DELETE_FILES_LIDARR",
      "MONITOR_DELETE_FILES_RADARR",
      "MONITOR_DELETE_FILES_SONARR",
      "MONITOR_DELETE_FILES_LIDARR",
    ]) {
      expect(supportsSearchAfter(t)).toBe(true);
    }
  });

  it("is true for every quality-profile action type", () => {
    for (const t of QUALITY_PROFILE_ACTION_TYPES) {
      expect(supportsSearchAfter(t)).toBe(true);
    }
  });

  it("is false for full deletes, unmonitor-only, dedicated search, and DO_NOTHING", () => {
    for (const t of [
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
    ]) {
      expect(supportsSearchAfter(t)).toBe(false);
    }
  });

  it("classifies every known action type without throwing", () => {
    const all = [...MOVIE_ACTION_TYPES, ...SERIES_ACTION_TYPES, ...MUSIC_ACTION_TYPES];
    for (const { value } of all) {
      expect(typeof supportsSearchAfter(value)).toBe("boolean");
    }
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
