import { describe, it, expect } from "vitest";
import { ruleSetCreateSchema, ruleSetUpdateSchema } from "@/lib/validation";

// A minimal rule group, as the rule editor sends it (values are strings).
const validGroup = {
  id: "g1",
  condition: "AND",
  rules: [{ id: "r1", field: "playCount", operator: "greaterThan", value: "5", condition: "AND" }],
  groups: [],
};

/** The distinct fields a failed parse names, as dotted paths. */
function failedPaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  expect(result.success).toBe(false);
  return [...new Set(result.error!.issues.map((i) => i.path.map(String).join(".")))].sort();
}

describe("actionDelayDays validation", () => {
  describe("ruleSetCreateSchema", () => {
    const basePayload = {
      name: "Test",
      type: "MOVIE" as const,
      rules: [validGroup],
      serverIds: ["server-1"],
    };

    it("accepts actionDelayDays = 0", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 0 });
      expect(result.success).toBe(true);
    });

    it("accepts actionDelayDays = 7 (default)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 7 });
      expect(result.success).toBe(true);
    });

    it("accepts actionDelayDays = 365 (max)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 365 });
      expect(result.success).toBe(true);
    });

    it("rejects actionDelayDays = -1 (negative)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: -1 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("rejects actionDelayDays = -30 (negative)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: -30 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("rejects actionDelayDays = 366 (over max)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 366 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("rejects actionDelayDays = 1.5 (non-integer)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 1.5 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("allows omitting actionDelayDays entirely", () => {
      const result = ruleSetCreateSchema.safeParse(basePayload);
      expect(result.success).toBe(true);
    });
  });

  describe("ruleSetUpdateSchema", () => {
    it("accepts actionDelayDays = 0", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionDelayDays: 0 });
      expect(result.success).toBe(true);
    });

    it("rejects actionDelayDays = -1 (negative)", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionDelayDays: -1 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("rejects actionDelayDays = 366 (over max)", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionDelayDays: 366 });
      expect(failedPaths(result)).toEqual(["actionDelayDays"]);
    });

    it("allows omitting actionDelayDays entirely", () => {
      const result = ruleSetUpdateSchema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });
  });
});

describe("actionType validation", () => {
  describe("ruleSetCreateSchema", () => {
    const basePayload = {
      name: "Test",
      type: "MOVIE" as const,
      rules: [validGroup],
      serverIds: ["server-1"],
    };

    it("accepts known action types", () => {
      const validTypes = [
        "DO_NOTHING",
        "DELETE_RADARR", "DELETE_SONARR", "DELETE_LIDARR",
        "UNMONITOR_RADARR", "UNMONITOR_SONARR", "UNMONITOR_LIDARR",
        "UNMONITOR_DELETE_FILES_RADARR", "UNMONITOR_DELETE_FILES_SONARR", "UNMONITOR_DELETE_FILES_LIDARR",
        "MONITOR_DELETE_FILES_RADARR", "MONITOR_DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_LIDARR",
        "DELETE_FILES_RADARR", "DELETE_FILES_SONARR", "DELETE_FILES_LIDARR",
        "CHANGE_QUALITY_PROFILE_RADARR", "CHANGE_QUALITY_PROFILE_SONARR", "CHANGE_QUALITY_PROFILE_LIDARR",
        "SEARCH_RADARR", "SEARCH_SONARR", "SEARCH_LIDARR",
      ];

      for (const actionType of validTypes) {
        const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType });
        expect(result.success, `Expected ${actionType} to be accepted`).toBe(true);
      }
    });

    it("accepts integer targetQualityProfileId", () => {
      const result = ruleSetCreateSchema.safeParse({
        ...basePayload,
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        targetQualityProfileId: 7,
      });
      expect(result.success).toBe(true);
    });

    it("accepts null targetQualityProfileId", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, targetQualityProfileId: null });
      expect(result.success).toBe(true);
    });

    it("rejects non-integer targetQualityProfileId", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, targetQualityProfileId: 1.5 });
      expect(failedPaths(result)).toEqual(["targetQualityProfileId"]);
    });

    it("rejects string targetQualityProfileId", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, targetQualityProfileId: "7" });
      expect(failedPaths(result)).toEqual(["targetQualityProfileId"]);
    });

    it("accepts null actionType", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: null });
      expect(result.success).toBe(true);
    });

    it("allows omitting actionType entirely", () => {
      const result = ruleSetCreateSchema.safeParse(basePayload);
      expect(result.success).toBe(true);
    });

    it("rejects unknown action type strings", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: "DELETE_EVERYTHING" });
      expect(failedPaths(result)).toEqual(["actionType"]);
    });

    it("rejects empty string action type", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: "" });
      expect(failedPaths(result)).toEqual(["actionType"]);
    });

    it("rejects numeric action type", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: 42 });
      expect(failedPaths(result)).toEqual(["actionType"]);
    });
  });

  describe("ruleSetUpdateSchema", () => {
    it("accepts known action type", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionType: "DELETE_RADARR" });
      expect(result.success).toBe(true);
    });

    it("accepts null actionType", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionType: null });
      expect(result.success).toBe(true);
    });

    it("rejects unknown action type strings", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionType: "NUKE_FROM_ORBIT" });
      expect(failedPaths(result)).toEqual(["actionType"]);
    });

    it("allows omitting actionType entirely", () => {
      const result = ruleSetUpdateSchema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });
  });
});
