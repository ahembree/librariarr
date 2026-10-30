/**
 * Shared formatting utilities for consistent display across the application.
 *
 * All file size formatting uses binary (base-2: 1 KiB = 1024 B) units
 * to match what operating systems and media tools report.
 */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * Format a byte count (passed as string from BigInt serialization) for display.
 * Returns "-" for null/zero values.
 */
export function formatFileSize(bytes: string | null): string {
  if (!bytes) return "-";
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return "-";
  const i = Math.min(Math.floor(Math.log(num) / Math.log(1024)), SIZE_UNITS.length - 1);
  const value = num / Math.pow(1024, i);
  return `${value.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

/**
 * Format a byte count (passed as number) for display.
 * Returns "0 B" for zero/falsy values. Used by stats cards where the value is already a number.
 */
export function formatBytesNum(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${SIZE_UNITS[i]}`;
}

/**
 * Format milliseconds as a human-readable duration: "Xh Xm" or "Xm".
 * Returns "-" for null/zero values.
 */
export function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/**
 * Format milliseconds as a scaled duration for large totals.
 * Picks the largest appropriate unit: "Xm", "Xh Xm", "Xd Xh", "Xmo Xd", or "Xy Xmo".
 * Returns "-" for null/zero values.
 */
export function formatDurationLarge(ms: number | null): string {
  if (!ms) return "-";
  const totalMinutes = Math.round(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const totalMonths = Math.floor(totalDays / 30);
  const totalYears = Math.floor(totalDays / 365);

  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    if (totalHours === 0) return `${minutes}m`;
    return `${totalHours}h ${minutes}m`;
  }
  if (totalDays < 30) {
    const remainingHours = totalHours % 24;
    return `${totalDays}d ${remainingHours}h`;
  }
  if (totalDays < 365) {
    const remainingDays = totalDays - totalMonths * 30;
    return `${totalMonths}mo ${remainingDays}d`;
  }
  const remainingMonths = Math.floor((totalDays - totalYears * 365) / 30);
  return `${totalYears}y ${remainingMonths}mo`;
}

/**
 * Format milliseconds as a clock-style duration: "H:MM:SS" or "M:SS".
 * Used for stream progress display.
 */
export function formatDurationClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Format a date string for display: "January 1, 2024".
 * Returns the fallback string for null values (defaults to "-").
 */
export function formatDate(date: string | null, fallback: string = "-"): string {
  if (!date) return fallback;
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a calendar date — a release, premiere or air date — for display:
 * "July 16, 2010" (`month: "short"` → "Jul 16, 2010").
 *
 * These are days, not instants: the sync stores Plex's "2010-07-16" as
 * `new Date("2010-07-16")`, UTC midnight, and the Arr apps send theirs as UTC
 * midnight too, so `formatDate`'s local-time reading showed the day before
 * anywhere west of UTC. Read in UTC, it is the stored day in every timezone.
 * Real instants (added, last played) keep `formatDate`.
 */
export function formatDateOnly(
  date: string | number | Date | null | undefined,
  fallback: string = "-",
  month: "long" | "short" = "long",
): string {
  if (date === null || date === undefined || date === "") return fallback;
  const d = new Date(date);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString("en-US", { year: "numeric", month, day: "numeric", timeZone: "UTC" });
}

/**
 * Format a future date string as a compact countdown: "in 3m", "in 3h",
 * "in 2d", "in 1w". Returns "now" for past or imminent (<1 minute) dates
 * and "-" for null (e.g. manual-only schedules).
 */
export function formatUntil(dateStr: string | null, now: number = Date.now()): string {
  if (!dateStr) return "-";
  const diffMs = new Date(dateStr).getTime() - now;
  if (diffMs < 60_000) return "now";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `in ${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `in ${diffDay}d`;
  return `in ${Math.floor(diffDay / 7)}w`;
}

export interface RelativeDateOptions {
  /**
   * `"day"` stops at days — "1d ago", "40d ago" — where the default reads
   * "Yesterday", weeks, months and years. The sync status uses it: a sync's
   * age is read against the schedule, which runs in hours and days.
   */
  largestUnit?: "day";
  /**
   * The time to measure from (epoch ms), the current time by default. A
   * server-rendered page passes its render time until it has hydrated, so the
   * two renders agree.
   */
  now?: number;
}

/**
 * Format a date as a short relative time: "just now", "5m ago", "2d ago",
 * "3w ago".
 */
export function formatRelativeDate(dateStr: string | Date, options: RelativeDateOptions = {}): string {
  const date = new Date(dateStr);
  const now = options.now ?? Date.now();
  // Clamped: a timestamp from a server whose clock runs ahead of the browser's
  // is "in the future" here, and floored negatives rendered it as "-1d ago".
  const diffMs = Math.max(0, now - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay === 0) {
    if (diffHour > 0) return `${diffHour}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "just now";
  }
  if (options.largestUnit === "day") return `${diffDay}d ago`;
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}

/**
 * A sync's remaining time from its rate so far: "~40s left", "~12m left",
 * "~2h 5m left". Null before there is a rate to go on (nothing processed, no
 * total, or under five seconds in, where the estimate swings wildly).
 */
export function formatSyncEta(
  startedAt: string | Date,
  processed: number,
  total: number,
  now: number = Date.now(),
): string | null {
  if (processed <= 0 || total <= 0) return null;
  const elapsed = (now - new Date(startedAt).getTime()) / 1000;
  if (elapsed < 5) return null;
  const rate = processed / elapsed;
  const remaining = Math.ceil((total - processed) / rate);
  if (remaining < 60) return `~${remaining}s left`;
  const mins = Math.ceil(remaining / 60);
  if (mins < 60) return `~${mins}m left`;
  const hrs = Math.floor(mins / 60);
  return `~${hrs}h ${mins % 60}m left`;
}

/**
 * An instant as the browser's locale writes a date and time ("1/2/2026,
 * 3:04:05 PM"), or `fallback` when there is none — "Never" for a last run.
 */
export function formatDateTime(date: string | Date | null | undefined, fallback: string = "-"): string {
  if (!date) return fallback;
  const d = new Date(date);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

/**
 * When a play happened, always with its clock time: "Today 21:04",
 * "Yesterday 08:15", "Mar 3 21:04" (the year added once it is not this one).
 *
 * The History page used to show "3d ago" within a week and a bare date past
 * it; the per-item play lists showed this. This one wins: watch history is
 * about *when* something was played, and a relative "2d ago" alone cannot tell
 * two plays on the same evening apart.
 */
export function formatWatchedAt(
  dateStr: string | Date | null | undefined,
  fallback: string = "Unknown date",
  now: Date = new Date(),
): string {
  if (!dateStr) return fallback;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return fallback;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const watchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - watchDay.getTime()) / 86400000);

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
  return `${day} ${time}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in local time — the value format of `<input type="date">`. */
export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `YYYY-MM-DDTHH:mm` in local time — the value format of `<input type="datetime-local">`. */
export function toDatetimeLocalValue(date: Date): string {
  return `${localDateString(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const CHANNEL_LABELS: Record<number, string> = {
  1: "Mono",
  2: "Stereo",
  3: "2.1",
  6: "5.1",
  8: "7.1",
};

// The dashboard's breakdown legend spells the common layouts out.
const VERBOSE_CHANNEL_LABELS: Record<number, string> = {
  1: "Mono (1.0)",
  2: "Stereo (2.0)",
  3: "2.1",
  6: "5.1 Surround",
  8: "7.1 Surround",
};

/**
 * An audio channel count as a layout name: "Stereo", "5.1", or "4ch" for one
 * without a name. `verbose` reads "Stereo (2.0)", "5.1 Surround".
 */
export function formatChannels(channels: number, options: { verbose?: boolean } = {}): string {
  const labels = options.verbose ? VERBOSE_CHANNEL_LABELS : CHANNEL_LABELS;
  return labels[channels] ?? `${channels}ch`;
}
