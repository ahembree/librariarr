/**
 * A schedule that cannot be evaluated never runs, so `isScheduleDue` reports
 * it — once per distinct problem, through a bounded set that cannot grow
 * without limit over a long-running process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: m.error },
}));

import { isScheduleDue, presetToCron } from "@/lib/jobs/schedule";

const now = new Date("2026-03-01T12:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("isScheduleDue with an unevaluable schedule", () => {
  it("is never due, and reports each distinct problem once", () => {
    expect(isScheduleDue("not a cron", null, now, "03:00")).toBe(false);
    expect(isScheduleDue("not a cron", null, now, "03:00")).toBe(false);
    expect(m.error).toHaveBeenCalledTimes(1);
    expect(String(m.error.mock.calls[0][1])).toContain('Schedule "not a cron" cannot be evaluated');
  });

  it("bounds the set of reported problems, reporting an old one again after it is cleared", () => {
    for (let i = 0; i < 101; i++) isScheduleDue(`bad schedule ${i}`, null, now, "03:00");
    const reportsBefore = m.error.mock.calls.length;
    // Every distinct expression was reported once.
    expect(reportsBefore).toBe(101);

    // The 101st report cleared the set, so the first one is reported again.
    isScheduleDue("bad schedule 0", null, now, "03:00");
    expect(m.error).toHaveBeenCalledTimes(reportsBefore + 1);
  });
});

describe("presetToCron", () => {
  it("returns null for MANUAL and unknown presets", () => {
    expect(presetToCron("MANUAL", "03:00")).toBeNull();
    expect(presetToCron("HOURLY", "03:00")).toBeNull();
  });
});
