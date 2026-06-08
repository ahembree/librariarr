import { CronExpressionParser } from "cron-parser";

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
 * Check if a schedule is due based on its cron expression (preset or custom).
 *
 * Returns true when the most recent scheduled fire time is more recent than the
 * last recorded run. Updating the "last run" timestamp before enqueueing work
 * prevents a restart from re-triggering the same window (retry storms).
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

  try {
    const tz = getSystemTimezone();
    const interval = CronExpressionParser.parse(cronExpr, { currentDate: now, tz });
    const prevRun = interval.prev().toDate();
    return !lastRun || prevRun.getTime() > lastRun.getTime();
  } catch {
    return false;
  }
}
