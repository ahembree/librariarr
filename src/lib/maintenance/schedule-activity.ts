/**
 * Whether a blackout or preroll schedule's window is open at a given moment.
 *
 * The ONE definition, shared by the enforcer (which acts on it) and the Preroll
 * page (whose "Active" badge reports it). Client-safe — no server imports — so
 * both read the same rules. The page used to keep its own copy, which compared
 * a seasonal schedule's dates including the year (the enforcer repeats it
 * every year) and checked an overnight window against today's weekday only
 * (the enforcer counts the hours after midnight towards the day it started),
 * so the badge and what actually played disagreed.
 *
 * Times are compared in the local timezone of whoever calls it: the server's
 * for the enforcer, the browser's for the page.
 */

export interface ScheduleWindow {
  scheduleType: string;
  /** A Date on the server, its ISO string once it has been through JSON. */
  startDate: Date | string | null;
  endDate: Date | string | null;
  daysOfWeek: unknown;
  startTime: string | null;
  endTime: string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** One-time and recurring windows — the schedule types blackouts have. */
export function isBlackoutWindowActive(schedule: ScheduleWindow, now: Date = new Date()): boolean {
  if (schedule.scheduleType === "one_time") {
    if (!schedule.startDate || !schedule.endDate) return false;
    return now >= toDate(schedule.startDate) && now <= toDate(schedule.endDate);
  }

  if (schedule.scheduleType === "recurring") {
    const days = schedule.daysOfWeek as number[] | null;
    if (!Array.isArray(days) || !schedule.startTime || !schedule.endTime) return false;

    const [startH, startM] = schedule.startTime.split(":").map(Number);
    const [endH, endM] = schedule.endTime.split(":").map(Number);
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    const today = now.getDay();

    // Overnight spans (e.g. 22:00 to 06:00) run past midnight into the NEXT
    // calendar day, so the selected day identifies when the window *starts*.
    // Testing the day against `now` alone both truncated the window at
    // midnight and made it spuriously active in the small hours of the
    // start day itself.
    if (endMin <= startMin) {
      const yesterday = (today + 6) % 7;
      return (
        (days.includes(today) && currentMin >= startMin) ||
        (days.includes(yesterday) && currentMin <= endMin)
      );
    }

    return days.includes(today) && currentMin >= startMin && currentMin <= endMin;
  }

  return false;
}

/**
 * Preroll windows: the blackout types plus seasonal — an annually-recurring
 * date range (month/day compared, year ignored). Seasonal is not a blackout
 * type, so without this branch it fell through to `false` and never activated.
 */
export function isPrerollWindowActive(schedule: ScheduleWindow, now: Date = new Date()): boolean {
  if (schedule.scheduleType === "seasonal") {
    if (!schedule.startDate || !schedule.endDate) return false;
    const md = (d: Date) => (d.getMonth() + 1) * 100 + d.getDate();
    const cur = md(now);
    const start = md(toDate(schedule.startDate));
    const end = md(toDate(schedule.endDate));
    // Wrap across the year boundary (e.g. Dec 15 → Jan 5).
    if (end < start) return cur >= start || cur <= end;
    return cur >= start && cur <= end;
  }
  return isBlackoutWindowActive(schedule, now);
}
