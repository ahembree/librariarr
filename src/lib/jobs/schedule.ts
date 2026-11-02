import { CronExpressionParser } from "cron-parser";
import cron from "node-cron";
import { logger } from "@/lib/logger";

/** Known preset schedule names (used by presetToCron). */
const PRESET_SCHEDULES = new Set(["EVERY_6H", "EVERY_12H", "DAILY", "WEEKLY"]);

/**
 * Get the system's IANA timezone identifier.
 * Respects the TZ environment variable (common in Docker containers).
 * Falls back to the Node.js runtime's resolved timezone.
 */
export function getSystemTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Convert a preset schedule + time-of-day anchor into a cron expression.
 * Returns null for MANUAL or unknown presets.
 */
export function presetToCron(preset: string, timeOfDay: string): string | null {
  if (!PRESET_SCHEDULES.has(preset)) return null;

  const [hours, minutes] = timeOfDay.split(":").map(Number);

  switch (preset) {
    case "DAILY":
      return `${minutes} ${hours} * * *`;
    case "EVERY_12H":
      return `${minutes} ${hours},${(hours + 12) % 24} * * *`;
    case "EVERY_6H":
      return `${minutes} ${hours},${(hours + 6) % 24},${(hours + 12) % 24},${(hours + 18) % 24} * * *`;
    case "WEEKLY":
      return `${minutes} ${hours} * * 1`;
    default:
      return null;
  }
}

/**
 * Whether a schedule setting may be saved: MANUAL, a preset, or a cron
 * expression the dispatcher can actually run.
 *
 * The settings routes used to check with node-cron while `isScheduleDue`
 * evaluates with cron-parser, and the two disagree: node-cron accepts
 * wrap-around ranges ("0 22-2 * * *", "FRI-MON") and `W`, which cron-parser
 * refuses — so such a schedule saved without complaint and then never ran.
 * It must therefore parse with cron-parser. node-cron stays as a second gate
 * because cron-parser alone accepts things no cron means: `H` (a value drawn
 * at random on every parse, so the time would move every minute) and an
 * empty expression (every minute).
 */
export function isValidSchedule(value: string): boolean {
  if (value === "MANUAL" || PRESET_SCHEDULES.has(value)) return true;
  if (!cron.validate(value)) return false;
  try {
    CronExpressionParser.parse(value, { tz: "UTC" }).prev();
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock time `date` shows in `tz`, as a Date whose UTC fields hold
 * it (so 01:30 local reads back as 01:30Z). Throws for an unknown timezone.
 */
function localWallClock(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(
    Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"), date.getUTCMilliseconds()),
  );
}

// Schedules already reported as unrunnable, so a broken one logs once per
// process rather than on every dispatcher tick (each log line is a DB row).
const reportedUnrunnable = new Set<string>();

/**
 * Check if a schedule is due based on its cron expression (preset or custom).
 *
 * Returns true when the most recent scheduled fire time is more recent than the
 * last recorded run. The dispatcher records "last run" as the moment it
 * enqueued the work, so a restart cannot re-trigger the same window.
 *
 * A schedule naming fixed hours (every preset) is compared on the server's
 * local WALL CLOCK rather than on instants, which is what makes a daylight
 * saving change behave: on the night the clocks go back, 01:30 happens twice
 * and an instant-based check ran a 01:30 job at both; on the night they go
 * forward, 02:30 never happens and an instant-based check skipped that day's
 * run. On the wall clock the repeated 01:30 is the one already run, and the
 * missing 02:30 is due as soon as the clock jumps past it. A schedule whose
 * hour field names every hour (`*`, a step of 1, `0-23`) fires every hour anyway,
 * so it keeps real time — on the wall clock it would sit out the repeated hour.
 */
export function isScheduleDue(
  schedule: string,
  lastRun: Date | null,
  now: Date,
  scheduledJobTime: string,
): boolean {
  if (schedule === "MANUAL") return false;

  // Convert preset schedules to cron using the user's configured time anchor
  const cronExpr = presetToCron(schedule, scheduledJobTime) ?? schedule;
  const tz = getSystemTimezone();

  try {
    // Every hour however it is spelled: `*/1` and `0-23` are not reported as
    // a wildcard, and on the wall clock they would sit out the repeated hour.
    const everyHour = CronExpressionParser.parse(cronExpr, { tz: "UTC" }).fields.hour.values.length === 24;
    if (everyHour) {
      const prevRun = CronExpressionParser.parse(cronExpr, { currentDate: now, tz }).prev().toDate();
      return !lastRun || prevRun.getTime() > lastRun.getTime();
    }
    const prevRun = CronExpressionParser.parse(cronExpr, {
      currentDate: localWallClock(now, tz),
      tz: "UTC",
    }).prev().toDate();
    return !lastRun || prevRun.getTime() > localWallClock(lastRun, tz).getTime();
  } catch (error) {
    // Never silently: a schedule that cannot be evaluated never runs, and
    // nothing else would say so (an unparseable stored expression, or a TZ
    // that is not an IANA name, such as a POSIX rule string).
    const reason = error instanceof Error ? error.message : String(error);
    const key = `${cronExpr}\n${tz}\n${reason}`;
    if (!reportedUnrunnable.has(key)) {
      if (reportedUnrunnable.size >= 100) reportedUnrunnable.clear();
      reportedUnrunnable.add(key);
      logger.error(
        "Jobs",
        `Schedule "${schedule}" cannot be evaluated in timezone "${tz}" and will not run until it is changed: ${reason}`,
      );
    }
    return false;
  }
}
