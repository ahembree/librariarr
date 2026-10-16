import { describe, it, expect } from "vitest";
import {
  isBlackoutWindowActive,
  isPrerollWindowActive,
  type ScheduleWindow,
} from "@/lib/maintenance/schedule-activity";

/**
 * The shared window rules behind the enforcer and the Preroll page's "Active"
 * badge. The page used to keep its own copy and disagreed with the enforcer on
 * both cases below. Dates are built in local time, as both callers compare.
 */
const base: ScheduleWindow = {
  scheduleType: "recurring",
  startDate: null,
  endDate: null,
  daysOfWeek: null,
  startTime: null,
  endTime: null,
};

describe("isPrerollWindowActive — seasonal", () => {
  // Saved in 2023 (as the holiday presets do: the year it was created), it
  // repeats every year — the page compared the full dates and called it
  // inactive from 2024 on while the enforcer played it.
  const christmas: ScheduleWindow = {
    ...base,
    scheduleType: "seasonal",
    // ISO strings, as the page receives them over JSON.
    startDate: new Date(2023, 11, 1, 0, 0).toISOString(),
    endDate: new Date(2023, 11, 26, 23, 59).toISOString(),
  };

  it("is active in a later year inside the month/day range", () => {
    expect(isPrerollWindowActive(christmas, new Date(2026, 11, 10, 12, 0))).toBe(true);
  });

  it("is inactive outside the month/day range", () => {
    expect(isPrerollWindowActive(christmas, new Date(2026, 6, 10, 12, 0))).toBe(false);
  });

  it("wraps across the year boundary", () => {
    const newYear: ScheduleWindow = {
      ...base,
      scheduleType: "seasonal",
      startDate: new Date(2024, 11, 15),
      endDate: new Date(2025, 0, 5),
    };
    expect(isPrerollWindowActive(newYear, new Date(2027, 0, 3, 9, 0))).toBe(true);
    expect(isPrerollWindowActive(newYear, new Date(2027, 0, 10, 9, 0))).toBe(false);
  });

  it("is not a blackout type", () => {
    expect(isBlackoutWindowActive({ ...christmas }, new Date(2023, 11, 10))).toBe(false);
  });
});

describe("recurring overnight windows", () => {
  // Friday 22:00 → 06:00: the hours after midnight belong to Friday's window.
  const fridayNight: ScheduleWindow = {
    ...base,
    daysOfWeek: [5],
    startTime: "22:00",
    endTime: "06:00",
  };
  // 2026-10-16 is a Friday.
  const friday = (h: number, m = 0) => new Date(2026, 9, 16, h, m);
  const saturday = (h: number, m = 0) => new Date(2026, 9, 17, h, m);

  it("is active on Saturday morning before the end time", () => {
    // The page checked Saturday against [5] and showed it inactive.
    expect(isPrerollWindowActive(fridayNight, saturday(3))).toBe(true);
    expect(isBlackoutWindowActive(fridayNight, saturday(3))).toBe(true);
  });

  it("is not active in the small hours of Friday itself", () => {
    // The page treated Friday 03:00 as inside Friday's window.
    expect(isPrerollWindowActive(fridayNight, friday(3))).toBe(false);
  });

  it("is active Friday evening after the start time", () => {
    expect(isPrerollWindowActive(fridayNight, friday(23))).toBe(true);
    expect(isPrerollWindowActive(fridayNight, friday(21, 59))).toBe(false);
  });

  it("handles a same-day window", () => {
    const evening: ScheduleWindow = { ...base, daysOfWeek: [5], startTime: "18:00", endTime: "20:00" };
    expect(isPrerollWindowActive(evening, friday(19))).toBe(true);
    expect(isPrerollWindowActive(evening, saturday(19))).toBe(false);
  });
});

describe("one-time windows", () => {
  it("compares the absolute dates", () => {
    const once: ScheduleWindow = {
      ...base,
      scheduleType: "one_time",
      startDate: "2026-10-16T10:00:00.000Z",
      endDate: "2026-10-16T12:00:00.000Z",
    };
    expect(isPrerollWindowActive(once, new Date("2026-10-16T11:00:00.000Z"))).toBe(true);
    expect(isPrerollWindowActive(once, new Date("2027-10-16T11:00:00.000Z"))).toBe(false);
  });
});
