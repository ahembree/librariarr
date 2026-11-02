/**
 * How the Preroll and Stream Manager pages describe a schedule window — a
 * recurring weekly window, or a one-time / seasonal date range. Client-safe.
 */

/** Day labels indexed by `Date.getDay()` (0 = Sunday), as schedules store days. */
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ScheduleWindow {
  scheduleType: string;
  daysOfWeek?: readonly number[] | null;
  /** "HH:mm" */
  startTime?: string | null;
  endTime?: string | null;
  /** ISO instants. */
  startDate?: string | null;
  endDate?: string | null;
}

export interface ScheduleFormatOptions {
  /** `"12h"` writes 9:00 AM; `"raw"` (default) the stored 09:00. */
  timeStyle?: "12h" | "raw";
  /** A recurring window's times when unset (the preroll enforcer reads 00:00–23:59). */
  defaultStartTime?: string;
  defaultEndTime?: string;
  /** What an unset time or date reads. */
  missing?: string;
}

/** "HH:mm" → "9:00 AM". */
export function formatTimeOfDay12h(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
}

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * "Every Mon, Wed 9:00 AM - 5:00 PM" for a recurring window (days in week
 * order — the stored list is copied, never sorted in place, since it is the
 * page's state), "Dec 1, 2026, 12:00 AM - Dec 26, 2026, 11:59 PM" for a
 * one-time or seasonal one.
 */
export function formatScheduleWindow(schedule: ScheduleWindow, options: ScheduleFormatOptions = {}): string {
  const { timeStyle = "raw", missing = "?" } = options;

  if (schedule.scheduleType === "recurring") {
    const days = [...(schedule.daysOfWeek ?? [])].sort((a, b) => a - b).map((d) => DAY_LABELS[d]);
    const time = (value: string | null | undefined, fallback: string | undefined) => {
      const t = value || fallback;
      if (!t) return missing;
      return timeStyle === "12h" ? formatTimeOfDay12h(t) : t;
    };
    const dayText = days.length > 0 ? days.join(", ") : "No days selected";
    return `Every ${dayText} ${time(schedule.startTime, options.defaultStartTime)} - ${time(schedule.endTime, options.defaultEndTime)}`;
  }

  if (schedule.scheduleType === "one_time" || schedule.scheduleType === "seasonal") {
    const date = (value: string | null | undefined) =>
      value ? new Date(value).toLocaleString(undefined, DATE_TIME_OPTIONS) : missing;
    return `${date(schedule.startDate)} - ${date(schedule.endDate)}`;
  }

  return "Unknown schedule type";
}
