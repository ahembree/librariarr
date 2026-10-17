/**
 * Shared schedule-conflict detection for preroll schedules.
 *
 * Used by both the preroll schedule create (POST) and update (PUT) routes to
 * reject overlapping enabled schedules of the same kind:
 *   - one_time / seasonal: date windows that are open at the same time
 *   - recurring: weekly time windows that are open at the same time
 *
 * "Open" means what `isPrerollWindowActive` (`src/lib/maintenance/
 * schedule-activity.ts`) — what the enforcer acts on — says: an overnight
 * recurring window (e.g. Mon 22:00–06:00) belongs to the day it STARTS and
 * runs into the next morning, and a seasonal schedule repeats every year on
 * its month/day, whole days, whatever year it was saved in. This module used
 * to split an overnight window into two same-day ranges and compare seasonal
 * dates including the year, so it flagged schedules that are never open
 * together and missed ones that are.
 *
 * Windows that only touch (one ends as the other starts) are not a conflict.
 */

interface ScheduleConflictInput {
  scheduleType?: string;
  startDate?: string;
  endDate?: string;
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
}

export interface ScheduleConflictRecord {
  id: string;
  enabled: boolean;
  scheduleType: string;
  startDate: Date | null;
  endDate: Date | null;
  daysOfWeek: unknown;
  startTime: string | null;
  endTime: string | null;
  name: string;
}

const MINUTES_IN_DAY = 24 * 60;
const MINUTES_IN_WEEK = 7 * MINUTES_IN_DAY;
/** Enough days to have visited every month/day, Feb 29 included. */
const MAX_DAYS_TO_SCAN = 4 * 366;

/** Convert an "HH:mm" string to minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** True if two half-open [start, end) ranges overlap by more than a point. */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * A recurring schedule as half-open minute ranges over one week, minute 0
 * being Sunday 00:00. A window whose end is not after its start is overnight
 * and runs from its start day into the next (Saturday's into Sunday, at the
 * start of the week) — the reading `isBlackoutWindowActive` gives it.
 */
function weeklyRanges(days: number[], startTime: string, endTime: string): [number, number][] {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  const length = endMin > startMin ? endMin - startMin : MINUTES_IN_DAY - startMin + endMin;
  const ranges: [number, number][] = [];
  for (const day of new Set(days)) {
    // A stored day outside 0–6 never matches a weekday, so it is never open.
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const start = day * MINUTES_IN_DAY + startMin;
    const end = start + length;
    if (end <= MINUTES_IN_WEEK) {
      ranges.push([start, end]);
    } else {
      ranges.push([start, MINUTES_IN_WEEK], [0, end - MINUTES_IN_WEEK]);
    }
  }
  return ranges;
}

/** A date's local month and day as one comparable number (Dec 25 → 1225). */
function monthDay(date: Date): number {
  return (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * A seasonal schedule's month/days as inclusive ranges, as
 * `isPrerollWindowActive` reads them: the year and time of day are ignored,
 * and a range whose end comes before its start wraps the new year.
 */
function seasonalRanges(start: Date, end: Date): [number, number][] {
  const s = monthDay(start);
  const e = monthDay(end);
  return e < s ? [[s, 1231], [101, e]] : [[s, e]];
}

function inSeasonal(md: number, ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => md >= s && md <= e);
}

/**
 * Whether a one-time window spends any time on a day the seasonal schedule is
 * open. Its end is exclusive, like every window here, so one ending at
 * midnight does not reach into the next day.
 */
function oneTimeMeetsSeasonal(start: Date, end: Date, seasonal: [number, number][]): boolean {
  const last = end.getTime() - 1;
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i <= MAX_DAYS_TO_SCAN && day.getTime() <= last; i++) {
    if (inSeasonal(monthDay(day), seasonal)) return true;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return false;
}

interface DateWindow {
  scheduleType: string;
  start: Date;
  end: Date;
}

function dateWindowsOverlap(a: DateWindow, b: DateWindow): boolean {
  if (a.scheduleType === "one_time" && b.scheduleType === "one_time") {
    return a.start < b.end && b.start < a.end;
  }
  if (a.scheduleType === "seasonal" && b.scheduleType === "seasonal") {
    const aRanges = seasonalRanges(a.start, a.end);
    const bRanges = seasonalRanges(b.start, b.end);
    // Inclusive: a seasonal schedule is open the whole of its last day.
    return aRanges.some(([as, ae]) => bRanges.some(([bs, be]) => as <= be && bs <= ae));
  }
  const [oneTime, seasonal] = a.scheduleType === "one_time" ? [a, b] : [b, a];
  return oneTimeMeetsSeasonal(oneTime.start, oneTime.end, seasonalRanges(seasonal.start, seasonal.end));
}

const isDateType = (type: string | undefined) => type === "one_time" || type === "seasonal";

/**
 * Find the first enabled schedule (excluding `excludeId`) that conflicts with
 * `input`. Returns its id/name, or null when there's no conflict.
 */
export function checkConflict(
  input: ScheduleConflictInput,
  existing: ScheduleConflictRecord[],
  excludeId?: string,
): { id: string; name: string } | null {
  const candidates = existing.filter((s) => s.enabled && s.id !== excludeId);

  for (const other of candidates) {
    if (isDateType(input.scheduleType) && isDateType(other.scheduleType)) {
      if (!input.startDate || !input.endDate || !other.startDate || !other.endDate) continue;
      const overlaps = dateWindowsOverlap(
        { scheduleType: input.scheduleType!, start: new Date(input.startDate), end: new Date(input.endDate) },
        { scheduleType: other.scheduleType, start: other.startDate, end: other.endDate },
      );
      if (overlaps) return { id: other.id, name: other.name };
    }

    if (input.scheduleType === "recurring" && other.scheduleType === "recurring") {
      const otherDays = Array.isArray(other.daysOfWeek) ? (other.daysOfWeek as number[]) : [];
      if (!input.daysOfWeek || !input.startTime || !input.endTime || !other.startTime || !other.endTime) continue;
      const inputRanges = weeklyRanges(input.daysOfWeek, input.startTime, input.endTime);
      const otherRanges = weeklyRanges(otherDays, other.startTime, other.endTime);
      if (inputRanges.some((a) => otherRanges.some((b) => rangesOverlap(a, b)))) {
        return { id: other.id, name: other.name };
      }
    }
  }

  return null;
}
