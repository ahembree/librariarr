import { describe, it, expect } from "vitest";
import {
  timeToMinutes,
  checkConflict,
  type ScheduleConflictRecord,
} from "@/lib/preroll/schedule-conflict";

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
    // ...and the early-morning side of the wrap (05:00–05:30) also overlaps.
    expect(
      checkConflict(overnight, [rec({ daysOfWeek: [1], startTime: "05:00", endTime: "05:30" })]),
    ).toEqual({ id: "other", name: "Other" });
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
