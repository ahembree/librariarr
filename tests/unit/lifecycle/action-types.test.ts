import { describe, it, expect } from "vitest";
import {
  supportsSearchAfter,
  QUALITY_PROFILE_ACTION_TYPES,
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
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
