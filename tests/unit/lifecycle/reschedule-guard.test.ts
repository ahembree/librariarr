import { describe, it, expect } from "vitest";
import { completedActionBlocksReschedule } from "@/lib/lifecycle/reschedule-guard";

describe("completedActionBlocksReschedule", () => {
  const actionedAt = new Date("2022-01-01T00:00:00Z");

  it("blocks when the match was detected before the action ran (continuous match)", () => {
    const detectedAt = new Date("2021-06-01T00:00:00Z");
    expect(completedActionBlocksReschedule(actionedAt, detectedAt)).toBe(true);
  });

  it("blocks when the match was detected at the same instant the action ran", () => {
    expect(completedActionBlocksReschedule(actionedAt, new Date(actionedAt))).toBe(true);
  });

  it("allows re-scheduling when the match was detected after the action ran (re-added item)", () => {
    const detectedAt = new Date("2023-06-01T00:00:00Z");
    expect(completedActionBlocksReschedule(actionedAt, detectedAt)).toBe(false);
  });

  it("blocks conservatively when there is no current match info", () => {
    expect(completedActionBlocksReschedule(actionedAt, undefined)).toBe(true);
  });
});
