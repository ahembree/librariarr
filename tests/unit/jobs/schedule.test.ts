import { describe, it, expect, beforeEach } from "vitest";
import { getSystemTimezone, presetToCron, isScheduleDue } from "@/lib/jobs/schedule";

// ---------------------------------------------------------------------------
// getSystemTimezone
// ---------------------------------------------------------------------------

describe("getSystemTimezone", () => {
  const origTZ = process.env.TZ;

  beforeEach(() => {
    if (origTZ !== undefined) {
      process.env.TZ = origTZ;
    } else {
      delete process.env.TZ;
    }
  });

  it("returns TZ env var when set", () => {
    process.env.TZ = "America/New_York";
    expect(getSystemTimezone()).toBe("America/New_York");
  });

  it("falls back to Intl timezone when TZ is not set", () => {
    delete process.env.TZ;
    const tz = getSystemTimezone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// presetToCron
// ---------------------------------------------------------------------------

describe("presetToCron", () => {
  it("returns null for MANUAL preset", () => {
    expect(presetToCron("MANUAL", "03:00")).toBeNull();
  });

  it("returns null for unknown preset", () => {
    expect(presetToCron("UNKNOWN_PRESET", "03:00")).toBeNull();
  });

  it("converts DAILY to correct cron", () => {
    expect(presetToCron("DAILY", "03:30")).toBe("30 3 * * *");
  });

  it("converts DAILY at midnight", () => {
    expect(presetToCron("DAILY", "00:00")).toBe("0 0 * * *");
  });

  it("converts EVERY_12H to two runs 12 hours apart", () => {
    expect(presetToCron("EVERY_12H", "02:15")).toBe("15 2,14 * * *");
  });

  it("converts EVERY_12H wrapping around midnight", () => {
    expect(presetToCron("EVERY_12H", "14:00")).toBe("0 14,2 * * *");
  });

  it("converts EVERY_6H to four runs 6 hours apart", () => {
    expect(presetToCron("EVERY_6H", "00:00")).toBe("0 0,6,12,18 * * *");
  });

  it("converts EVERY_6H with offset", () => {
    expect(presetToCron("EVERY_6H", "03:45")).toBe("45 3,9,15,21 * * *");
  });

  it("converts WEEKLY to Monday", () => {
    expect(presetToCron("WEEKLY", "05:00")).toBe("0 5 * * 1");
  });
});

// ---------------------------------------------------------------------------
// isScheduleDue
// ---------------------------------------------------------------------------

describe("isScheduleDue", () => {
  beforeEach(() => {
    process.env.TZ = "UTC";
  });

  it("is never due for MANUAL", () => {
    expect(isScheduleDue("MANUAL", null, new Date(), "00:00")).toBe(false);
  });

  it("is due when there is no prior run", () => {
    const now = new Date("2026-01-01T03:30:00Z");
    expect(isScheduleDue("DAILY", null, now, "03:00")).toBe(true);
  });

  it("is due when the last run predates the most recent fire time", () => {
    const now = new Date("2026-01-02T03:05:00Z"); // just after the 03:00 daily fire
    const lastRun = new Date("2026-01-01T03:00:00Z"); // yesterday's run
    expect(isScheduleDue("DAILY", lastRun, now, "03:00")).toBe(true);
  });

  it("is not due when already run within the current window", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const lastRun = new Date("2026-01-01T03:00:30Z"); // already ran today
    expect(isScheduleDue("DAILY", lastRun, now, "03:00")).toBe(false);
  });

  it("supports raw cron expressions", () => {
    const now = new Date("2026-01-01T00:05:30Z"); // just after the */5 fire at 00:05
    expect(isScheduleDue("*/5 * * * *", new Date("2026-01-01T00:00:30Z"), now, "00:00")).toBe(true);
  });

  it("returns false for an invalid cron expression", () => {
    expect(isScheduleDue("not a cron", null, new Date(), "00:00")).toBe(false);
  });
});
