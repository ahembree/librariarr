import { describe, it, expect } from "vitest";
import {
  timeToMinutes,
  checkConflict,
  type ScheduleConflictRecord,
} from "@/lib/preroll/schedule-conflict";
import { isPrerollWindowActive, type ScheduleWindow } from "@/lib/maintenance/schedule-activity";

function rec(o: Partial<ScheduleConflictRecord>): ScheduleConflictRecord {
  return {
    id: "other",
    enabled: true,
    scheduleType: "recurring",
    startDate: null,
    endDate: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    name: "Other",
    ...o,
  };
}

describe("timeToMinutes", () => {
  it("converts HH:mm to minutes since midnight", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("02:30")).toBe(150);
    expect(timeToMinutes("23:59")).toBe(1439);
  });
});

describe("checkConflict — recurring", () => {
  const input = {
    scheduleType: "recurring",
    daysOfWeek: [1],
    startTime: "02:00",
    endTime: "06:00",
  };

  it("flags an overlapping same-day time window", () => {
    const conflict = checkConflict(input, [
      rec({ daysOfWeek: [1], startTime: "05:00", endTime: "08:00" }),
    ]);
    expect(conflict).toEqual({ id: "other", name: "Other" });
  });

  it("ignores schedules with no shared day", () => {
    expect(
      checkConflict(input, [rec({ daysOfWeek: [2], startTime: "02:00", endTime: "06:00" })]),
    ).toBeNull();
  });

  it("ignores non-overlapping time windows on a shared day", () => {
    expect(
      checkConflict(input, [rec({ daysOfWeek: [1], startTime: "07:00", endTime: "09:00" })]),
    ).toBeNull();
  });

  it("detects overlap when the INPUT window spans midnight (overnight)", () => {
    // 22:00–06:00 wraps midnight; a 23:00–23:30 window on the same day overlaps.
    const overnight = { scheduleType: "recurring", daysOfWeek: [1], startTime: "22:00", endTime: "06:00" };
    expect(
      checkConflict(overnight, [rec({ daysOfWeek: [1], startTime: "23:00", endTime: "23:30" })]),
    ).toEqual({ id: "other", name: "Other" });
  });

  // An overnight window belongs to the day it STARTS (as `isPrerollWindowActive`
  // reads it): Monday 22:00–06:00 runs into Tuesday morning, not Monday's.
  it("treats Monday's overnight window as running into Tuesday morning", () => {
    const overnight = { scheduleType: "recurring", daysOfWeek: [1], startTime: "22:00", endTime: "06:00" };
    // Both are open on Tuesday at 05:00.
    expect(
      checkConflict(overnight, [rec({ daysOfWeek: [2], startTime: "05:00", endTime: "05:30" })]),
    ).toEqual({ id: "other", name: "Other" });
    // Monday 05:00–05:30 is before Monday's window opens and after Sunday's
    // (there is none) closed: never open together.
    expect(
      checkConflict(overnight, [rec({ daysOfWeek: [1], startTime: "05:00", endTime: "05:30" })]),
    ).toBeNull();
    // The same, with the overnight schedule as the stored one.
    expect(
      checkConflict(
        { scheduleType: "recurring", daysOfWeek: [2], startTime: "05:00", endTime: "05:30" },
        [rec({ daysOfWeek: [1], startTime: "22:00", endTime: "06:00" })],
      ),
    ).toEqual({ id: "other", name: "Other" });
  });

  it("carries Saturday's overnight window into Sunday morning", () => {
    const saturdayNight = { scheduleType: "recurring", daysOfWeek: [6], startTime: "23:00", endTime: "02:00" };
    expect(
      checkConflict(saturdayNight, [rec({ daysOfWeek: [0], startTime: "01:00", endTime: "03:00" })]),
    ).toEqual({ id: "other", name: "Other" });
    expect(
      checkConflict(saturdayNight, [rec({ daysOfWeek: [6], startTime: "01:00", endTime: "03:00" })]),
    ).toBeNull();
  });

  it("ignores a stored day outside 0-6, which is never open", () => {
    expect(
      checkConflict(
        { scheduleType: "recurring", daysOfWeek: [0], startTime: "00:00", endTime: "23:00" },
        [rec({ daysOfWeek: [7], startTime: "18:00", endTime: "23:00" })],
      ),
    ).toBeNull();
  });

  it("does not flag windows that only touch", () => {
    expect(
      checkConflict(input, [rec({ daysOfWeek: [1], startTime: "06:00", endTime: "08:00" })]),
    ).toBeNull();
    // An overnight window ending as the next day's window starts.
    expect(
      checkConflict(
        { scheduleType: "recurring", daysOfWeek: [1], startTime: "22:00", endTime: "06:00" },
        [rec({ daysOfWeek: [2], startTime: "06:00", endTime: "08:00" })],
      ),
    ).toBeNull();
  });

  it("does not falsely flag a daytime window against an overnight one", () => {
    const overnight = { scheduleType: "recurring", daysOfWeek: [1], startTime: "22:00", endTime: "06:00" };
    expect(
      checkConflict(overnight, [rec({ daysOfWeek: [1], startTime: "10:00", endTime: "12:00" })]),
    ).toBeNull();
  });
});

describe("checkConflict — one_time / seasonal", () => {
  const input = {
    scheduleType: "one_time" as const,
    startDate: "2030-01-01T00:00:00Z",
    endDate: "2030-01-05T00:00:00Z",
  };

  it("flags overlapping date ranges", () => {
    expect(
      checkConflict(input, [
        rec({
          scheduleType: "seasonal",
          startDate: new Date("2030-01-03T00:00:00Z"),
          endDate: new Date("2030-01-10T00:00:00Z"),
        }),
      ]),
    ).toEqual({ id: "other", name: "Other" });
  });

  // A seasonal schedule repeats every year on its month/day, whatever year
  // it was saved in.
  it("flags a one-time range against a seasonal one saved in another year", () => {
    const christmas = rec({
      scheduleType: "seasonal",
      startDate: new Date(2023, 11, 1, 0, 0),
      endDate: new Date(2023, 11, 26, 23, 59),
    });
    const oneTime = (start: Date, end: Date) => ({
      scheduleType: "one_time",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    expect(checkConflict(oneTime(new Date(2026, 11, 10), new Date(2026, 11, 12)), [christmas])).toEqual({
      id: "other",
      name: "Other",
    });
    // Its last day counts whole: the enforcer ignores the time of day.
    expect(checkConflict(oneTime(new Date(2026, 11, 26, 23, 59, 30), new Date(2026, 11, 27, 1)), [christmas])).toEqual({
      id: "other",
      name: "Other",
    });
    // Outside the month/days, in any year: no conflict. A one-time window
    // ending at midnight does not reach into the next day.
    expect(checkConflict(oneTime(new Date(2026, 10, 20), new Date(2026, 11, 1)), [christmas])).toBeNull();
    expect(checkConflict(oneTime(new Date(2026, 11, 27), new Date(2026, 11, 31)), [christmas])).toBeNull();
    // A one-time window long enough to cover a whole year meets every season.
    expect(checkConflict(oneTime(new Date(2026, 0, 2), new Date(2027, 0, 2)), [christmas])).not.toBeNull();
  });

  it("compares two seasonal schedules by month/day, wrapping the new year", () => {
    const winter = rec({
      scheduleType: "seasonal",
      startDate: new Date(2020, 11, 15),
      endDate: new Date(2021, 0, 5),
    });
    const seasonal = (start: Date, end: Date) => ({
      scheduleType: "seasonal",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    // Saved years apart, both open on Jan 2.
    expect(checkConflict(seasonal(new Date(2031, 0, 2), new Date(2031, 0, 20)), [winter])).not.toBeNull();
    // Both open the whole of Jan 5.
    expect(checkConflict(seasonal(new Date(2025, 0, 5, 12), new Date(2025, 1, 1)), [winter])).not.toBeNull();
    expect(checkConflict(seasonal(new Date(2025, 0, 6), new Date(2025, 11, 14)), [winter])).toBeNull();
  });

  it("ignores non-overlapping date ranges", () => {
    expect(
      checkConflict(input, [
        rec({
          scheduleType: "one_time",
          startDate: new Date("2030-02-01T00:00:00Z"),
          endDate: new Date("2030-02-05T00:00:00Z"),
        }),
      ]),
    ).toBeNull();
  });
});

describe("checkConflict — filtering", () => {
  const input = { scheduleType: "recurring", daysOfWeek: [1], startTime: "02:00", endTime: "06:00" };

  it("skips disabled schedules", () => {
    expect(
      checkConflict(input, [rec({ enabled: false, daysOfWeek: [1], startTime: "02:00", endTime: "06:00" })]),
    ).toBeNull();
  });

  it("skips the excluded id (self, on update)", () => {
    expect(
      checkConflict(input, [rec({ id: "self", daysOfWeek: [1], startTime: "02:00", endTime: "06:00" })], "self"),
    ).toBeNull();
  });

  it("does not compare across schedule types (recurring vs one_time)", () => {
    expect(
      checkConflict(input, [
        rec({
          scheduleType: "one_time",
          startDate: new Date("2030-01-01T00:00:00Z"),
          endDate: new Date("2030-01-05T00:00:00Z"),
        }),
      ]),
    ).toBeNull();
  });
});

/**
 * Conflict detection must answer the question the enforcer's window rules
 * (`isPrerollWindowActive`) pose: are the two ever open at once, for longer
 * than the instant one closes as the other opens? Checked by brute force over
 * random schedules. Dates are built in local time, as the enforcer compares.
 */
describe("checkConflict agrees with isPrerollWindowActive", () => {
  // Deterministic, so a failure reproduces.
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  it("for recurring windows, overnight ones included", () => {
    const random = rng(1);
    const int = (n: number) => Math.floor(random() * n);
    // Times on a 30-minute grid: a shared stretch longer than an instant then
    // always starts at a grid point g and contains minute g + 1.
    const schedule = () => {
      const days = [...new Set(Array.from({ length: 1 + int(3) }, () => int(7)))];
      return { days, startTime: hhmm(30 * int(48)), endTime: hhmm(30 * int(48)) };
    };
    const window = (s: ReturnType<typeof schedule>): ScheduleWindow => ({
      scheduleType: "recurring",
      startDate: null,
      endDate: null,
      daysOfWeek: s.days,
      startTime: s.startTime,
      endTime: s.endTime,
    });
    // Sunday 7 January 2024, local midnight; the minute after the week's last
    // is the next Sunday's first, as the week wraps.
    const at = (minute: number) => new Date(2024, 0, 7, 0, minute);

    const outcomes = new Set<boolean>();
    for (let i = 0; i < 300; i++) {
      const a = schedule();
      const b = schedule();
      const wa = window(a);
      const wb = window(b);
      let together = false;
      for (let g = 0; g < 7 * 24 * 60 && !together; g += 30) {
        together = [at(g), at(g + 1)].every((t) => isPrerollWindowActive(wa, t) && isPrerollWindowActive(wb, t));
      }
      const conflict = checkConflict(
        { scheduleType: "recurring", daysOfWeek: a.days, startTime: a.startTime, endTime: a.endTime },
        [rec({ daysOfWeek: b.days, startTime: b.startTime, endTime: b.endTime })],
      );
      expect({ a, b, conflict: conflict !== null }).toEqual({ a, b, conflict: together });
      outcomes.add(together);
    }
    // Not vacuous: the random pairs both conflict and do not.
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it("for seasonal and one-time date windows", () => {
    const random = rng(2);
    const int = (n: number) => Math.floor(random() * n);
    const randomDay = (year: number) => new Date(year, 0, 1 + int(366));
    // A seasonal range of up to two months, saved in any year; one that runs
    // past Dec 31 wraps the new year.
    const seasonal = () => {
      const start = randomDay(2018 + int(10));
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1 + int(60), int(24));
      return { scheduleType: "seasonal", start, end };
    };
    // A one-time range of up to six weeks, on hour boundaries.
    const oneTime = () => {
      const start = new Date(2026, 0, 1 + int(400), int(24));
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours() + 1 + int(42 * 24));
      return { scheduleType: "one_time", start, end };
    };
    const window = (s: { scheduleType: string; start: Date; end: Date }): ScheduleWindow => ({
      scheduleType: s.scheduleType,
      startDate: s.start,
      endDate: s.end,
      daysOfWeek: null,
      startTime: null,
      endTime: null,
    });

    const outcomes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const a = int(2) === 0 ? seasonal() : oneTime();
      const b = seasonal();
      const wa = window(a);
      const wb = window(b);
      let together = false;
      if (a.scheduleType === "one_time") {
        // Every hour the one-time window covers, sampled at its middle.
        for (let t = new Date(a.start); t < a.end && !together; t = new Date(t.getTime() + 3600_000)) {
          const mid = new Date(t.getTime() + 1800_000);
          together = isPrerollWindowActive(wa, mid) && isPrerollWindowActive(wb, mid);
        }
      } else {
        // Every day of four years, a leap year among them.
        for (let d = 0; d < 4 * 366 && !together; d++) {
          const noon = new Date(2027, 0, 1 + d, 12);
          together = isPrerollWindowActive(wa, noon) && isPrerollWindowActive(wb, noon);
        }
      }
      const conflict = checkConflict(
        { scheduleType: a.scheduleType, startDate: a.start.toISOString(), endDate: a.end.toISOString() },
        [rec({ scheduleType: "seasonal", startDate: b.start, endDate: b.end })],
      );
      const label = { a: [a.scheduleType, a.start.toString(), a.end.toString()], b: [b.start.toString(), b.end.toString()] };
      expect({ ...label, conflict: conflict !== null }).toEqual({ ...label, conflict: together });
      outcomes.add(`${a.scheduleType}:${together}`);
    }
    expect([...outcomes].sort()).toEqual(["one_time:false", "one_time:true", "seasonal:false", "seasonal:true"]);
  });
});
