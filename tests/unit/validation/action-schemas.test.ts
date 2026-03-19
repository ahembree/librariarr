import { describe, it, expect } from "vitest";
import { ruleSetCreateSchema, ruleSetUpdateSchema } from "@/lib/validation";

// Minimal valid rule for schema tests
const validRule = { id: "1", field: "playCount", operator: "greaterThan", value: 5, condition: "AND" };

describe("actionDelayDays validation", () => {
  describe("ruleSetCreateSchema", () => {
    const basePayload = {
      name: "Test",
      type: "MOVIE" as const,
      rules: [validRule],
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
      expect(result.success).toBe(false);
    });

    it("rejects actionDelayDays = -30 (negative)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: -30 });
      expect(result.success).toBe(false);
    });

    it("rejects actionDelayDays = 366 (over max)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 366 });
      expect(result.success).toBe(false);
    });

    it("rejects actionDelayDays = 1.5 (non-integer)", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionDelayDays: 1.5 });
      expect(result.success).toBe(false);
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
      expect(result.success).toBe(false);
    });

    it("rejects actionDelayDays = 366 (over max)", () => {
      const result = ruleSetUpdateSchema.safeParse({ actionDelayDays: 366 });
      expect(result.success).toBe(false);
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
      rules: [validRule],
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
      ];

      for (const actionType of validTypes) {
        const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType });
        expect(result.success, `Expected ${actionType} to be accepted`).toBe(true);
      }
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
      expect(result.success).toBe(false);
    });

    it("rejects empty string action type", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: "" });
      expect(result.success).toBe(false);
    });

    it("rejects numeric action type", () => {
      const result = ruleSetCreateSchema.safeParse({ ...basePayload, actionType: 42 });
      expect(result.success).toBe(false);
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
      expect(result.success).toBe(false);
    });

    it("allows omitting actionType entirely", () => {
      const result = ruleSetUpdateSchema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });
  });
});
