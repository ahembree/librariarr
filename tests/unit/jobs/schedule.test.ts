import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: log }));

import { getSystemTimezone, presetToCron, isScheduleDue, isValidSchedule } from "@/lib/jobs/schedule";

// ---------------------------------------------------------------------------
// getSystemTimezone
// ---------------------------------------------------------------------------

const origTZ = process.env.TZ;
function restoreTZ() {
  if (origTZ !== undefined) {
    process.env.TZ = origTZ;
  } else {
    delete process.env.TZ;
  }
}

describe("getSystemTimezone", () => {
  afterEach(restoreTZ);

  it("returns TZ env var when set", () => {
    process.env.TZ = "America/New_York";
    expect(getSystemTimezone()).toBe("America/New_York");
  });

  it("falls back to Intl timezone when TZ is not set", () => {
    delete process.env.TZ;
    expect(getSystemTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
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
  afterEach(restoreTZ);

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

  it("logs a schedule it cannot evaluate, once rather than on every tick", () => {
    log.error.mockClear();
    const expr = "0 22-2 * * *"; // a wrap-around range cron-parser refuses
    for (let i = 0; i < 5; i++) isScheduleDue(expr, null, new Date(), "00:00");
    const lines = log.error.mock.calls.filter(([, message]) => String(message).includes(expr));
    expect(lines).toHaveLength(1);
  });

  it("logs when the timezone is not an IANA name, instead of silently never running", () => {
    log.error.mockClear();
    process.env.TZ = "CET-1CEST,M3.5.0,M10.5.0/3";
    expect(isScheduleDue("DAILY", null, new Date(), "03:00")).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][1])).toContain(
      'Schedule "DAILY" cannot be evaluated in timezone "CET-1CEST,M3.5.0,M10.5.0/3"',
    );
  });
});

// ---------------------------------------------------------------------------
// isScheduleDue across daylight saving changes
// ---------------------------------------------------------------------------

/**
 * Run the per-minute dispatcher over [from, to), returning when the schedule
 * fired. It ticks one second past each minute, as the real one runs just after
 * it (a fire time is only "previous" once the clock is past it).
 */
function simulateDispatcher(schedule: string, time: string, from: string, to: string, lastRun: Date | null) {
  const fires: string[] = [];
  let watermark = lastRun;
  for (let t = Date.parse(from) + 1_000; t < Date.parse(to); t += 60_000) {
    const now = new Date(t);
    if (isScheduleDue(schedule, watermark, now, time)) {
      fires.push(now.toISOString());
      watermark = now; // the dispatcher advances lastScheduled* to `now`
    }
  }
  return fires;
}

describe("isScheduleDue across daylight saving changes (America/New_York)", () => {
  beforeEach(() => {
    process.env.TZ = "America/New_York";
  });
  afterEach(restoreTZ);

  it("runs a 01:30 daily schedule once on the night 01:30 happens twice", () => {
    // 2026-11-01: 01:30 local is 05:30Z (EDT) and again 06:30Z (EST).
    const fires = simulateDispatcher("DAILY", "01:30", "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z",
      new Date("2026-10-31T05:30:00Z"));
    expect(fires).toEqual(["2026-11-01T05:30:01.000Z"]);
  });

  it("runs a 02:30 daily schedule on the day 02:30 does not exist, when the clock jumps past it", () => {
    // 2026-03-08: local time jumps from 02:00 EST (07:00Z) to 03:00 EDT.
    const fires = simulateDispatcher("DAILY", "02:30", "2026-03-08T05:00:00Z", "2026-03-10T05:00:00Z",
      new Date("2026-03-07T07:30:00Z"));
    expect(fires).toEqual(["2026-03-08T07:00:01.000Z", "2026-03-09T06:30:01.000Z"]);
  });

  it("keeps the local time either side of the change", () => {
    const fires = simulateDispatcher("DAILY", "03:00", "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z",
      new Date("2026-10-30T07:00:00Z"));
    // 03:00 EDT (07:00Z), then 03:00 EST (08:00Z) on both later days.
    expect(fires).toEqual([
      "2026-10-31T07:00:01.000Z",
      "2026-11-01T08:00:01.000Z",
      "2026-11-02T08:00:01.000Z",
    ]);
  });

  it("an every-hour schedule keeps real time: it runs in both 01:00 hours", () => {
    const fires = simulateDispatcher("0 * * * *", "00:00", "2026-11-01T04:30:00Z", "2026-11-01T07:30:00Z",
      new Date("2026-11-01T04:00:00Z"));
    expect(fires).toEqual([
      "2026-11-01T05:00:01.000Z",
      "2026-11-01T06:00:01.000Z",
      "2026-11-01T07:00:01.000Z",
    ]);
  });

  it("so does an every-hour schedule that spells its hours out", () => {
    // `*/1` and `0-23` name every hour exactly as `*` does, but cron-parser
    // does not report them as a wildcard — evaluated on the wall clock they
    // sat out the repeated hour, unlike the `*` they are equivalent to.
    for (const schedule of ["0 */1 * * *", "0 0-23 * * *", "*/30 0-23 * * *"]) {
      const fires = simulateDispatcher(schedule, "00:00", "2026-11-01T04:30:00Z", "2026-11-01T07:30:00Z",
        new Date("2026-11-01T04:00:00Z"));
      expect(fires).toEqual(
        simulateDispatcher(schedule.replace(/ (\*\/1|0-23) /, " * "), "00:00", "2026-11-01T04:30:00Z",
          "2026-11-01T07:30:00Z", new Date("2026-11-01T04:00:00Z")),
      );
      expect(fires).toContain("2026-11-01T05:00:01.000Z");
      expect(fires).toContain("2026-11-01T06:00:01.000Z");
    }
  });
});

// ---------------------------------------------------------------------------
// isValidSchedule
// ---------------------------------------------------------------------------

describe("isValidSchedule", () => {
  it("accepts MANUAL and every preset", () => {
    for (const value of ["MANUAL", "EVERY_6H", "EVERY_12H", "DAILY", "WEEKLY"]) {
      expect(isValidSchedule(value)).toBe(true);
    }
  });

  it("accepts cron expressions the dispatcher can run", () => {
    for (const value of ["0 */4 * * *", "30 3 * * 1-5", "0 0 * * THU", "*/30 * * * * *", "@daily"]) {
      expect(isValidSchedule(value)).toBe(true);
      expect(isScheduleDue(value, null, new Date("2026-10-16T12:00:00Z"), "00:00")).toBe(true);
    }
  });

  it("refuses expressions node-cron accepts but the dispatcher cannot evaluate", () => {
    // Wrap-around ranges and `W`: these used to save, then never run.
    for (const value of ["0 22-2 * * *", "0 3 * * FRI-MON", "0 0 15-10 * *", "0 0 1W * *"]) {
      expect(isValidSchedule(value)).toBe(false);
    }
  });

  it("refuses what only cron-parser accepts", () => {
    // `H` draws a random value on every parse; an empty expression means every minute.
    for (const value of ["H * * * *", "", "   "]) {
      expect(isValidSchedule(value)).toBe(false);
    }
  });

  it("refuses garbage", () => {
    for (const value of ["not a cron", "60 * * * *", "0 0 31 2 *", "0 0 * * * * *"]) {
      expect(isValidSchedule(value)).toBe(false);
    }
  });
});
