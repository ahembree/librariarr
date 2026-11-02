import { describe, it, expect } from "vitest";
import { AVATAR_PALETTE, avatarColor, avatarInitial, hashString } from "@/lib/avatar";
import { DAY_LABELS, formatScheduleWindow, formatTimeOfDay12h } from "@/lib/schedule-format";
import { decisionChipClass, streamDecision } from "@/lib/media/stream-decision";

describe("avatar helpers", () => {
  it("hashes strings stably and never negative", () => {
    expect(hashString("")).toBe(0);
    expect(hashString("alice")).toBe(hashString("alice"));
    expect(hashString("alice")).not.toBe(hashString("bob"));
    // Long strings overflow 32 bits; the absolute value keeps the index valid.
    expect(hashString("x".repeat(1000))).toBeGreaterThanOrEqual(0);
  });

  it("gives every name a palette colour and its initial", () => {
    for (const name of ["alice", "Bob", "", "  ", "Émile", "x".repeat(500)]) {
      expect(AVATAR_PALETTE).toContain(avatarColor(name));
    }
    expect(avatarInitial("alice")).toBe("A");
    expect(avatarInitial("  bob")).toBe("B");
    expect(avatarInitial("")).toBe("?");
  });
});

describe("formatScheduleWindow", () => {
  it("writes a recurring window with the days in week order, without sorting the stored list", () => {
    const days = [3, 1];
    const schedule = { scheduleType: "recurring", daysOfWeek: days, startTime: "09:00", endTime: "17:30" };
    expect(formatScheduleWindow(schedule)).toBe("Every Mon, Wed 09:00 - 17:30");
    expect(formatScheduleWindow(schedule, { timeStyle: "12h" })).toBe("Every Mon, Wed 9:00 AM - 5:30 PM");
    expect(days).toEqual([3, 1]);
  });

  it("fills unset times from the defaults, else the placeholder, and names no days", () => {
    const schedule = { scheduleType: "recurring", daysOfWeek: [], startTime: null, endTime: null };
    expect(formatScheduleWindow(schedule)).toBe("Every No days selected ? - ?");
    expect(
      formatScheduleWindow(schedule, { timeStyle: "12h", defaultStartTime: "00:00", defaultEndTime: "23:59" }),
    ).toBe("Every No days selected 12:00 AM - 11:59 PM");
  });

  it("writes a one-time or seasonal range as dates, with the placeholder for a missing end", () => {
    const start = "2026-12-01T00:00:00.000Z";
    const expected = new Date(start).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(formatScheduleWindow({ scheduleType: "one_time", startDate: start, endDate: null })).toBe(`${expected} - ?`);
    expect(formatScheduleWindow({ scheduleType: "seasonal", startDate: null, endDate: null }, { missing: "N/A" })).toBe(
      "N/A - N/A",
    );
  });

  it("says so for a type it does not know", () => {
    expect(formatScheduleWindow({ scheduleType: "weird" })).toBe("Unknown schedule type");
  });

  it("writes 12-hour times", () => {
    expect(formatTimeOfDay12h("00:05")).toBe("12:05 AM");
    expect(formatTimeOfDay12h("12:00")).toBe("12:00 PM");
    expect(formatTimeOfDay12h("23:59")).toBe("11:59 PM");
    expect(DAY_LABELS[0]).toBe("Sun");
  });
});

describe("streamDecision", () => {
  it("knows nothing about a row with no decision data", () => {
    expect(streamDecision(null)).toBeNull();
    expect(streamDecision({})).toBeNull();
    expect(streamDecision({ isTranscode: null, videoDecision: null, audioDecision: "" })).toBeNull();
  });

  it("counts any re-encode as a transcode, audio-only included", () => {
    expect(streamDecision({ isTranscode: true })).toEqual({ kind: "transcode", label: "Transcode" });
    expect(streamDecision({ isTranscode: false, videoDecision: "copy", audioDecision: "transcode" })).toEqual({
      kind: "transcode",
      label: "Transcode",
    });
    expect(streamDecision({ videoDecision: "transcode" })?.kind).toBe("transcode");
  });

  it("reads a copy as a direct stream and the rest as direct play", () => {
    expect(streamDecision({ isTranscode: false, videoDecision: "copy" })).toEqual({
      kind: "direct-stream",
      label: "Direct Stream",
    });
    expect(streamDecision({ isTranscode: false })).toEqual({ kind: "direct-play", label: "Direct Play" });
    expect(streamDecision({ videoDecision: "directplay", audioDecision: "directplay" })?.kind).toBe("direct-play");
  });

  it("colours each kind", () => {
    expect(decisionChipClass("transcode")).toContain("amber");
    expect(decisionChipClass("direct-stream")).toContain("sky");
    expect(decisionChipClass("direct-play")).toContain("green");
  });
});
