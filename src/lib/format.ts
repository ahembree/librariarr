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
  if (num === 0) return "-";
  const i = Math.floor(Math.log(num) / Math.log(1024));
  const value = num / Math.pow(1024, i);
  return `${value.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

/**
 * Format a byte count (passed as number) for display.
 * Returns "0 B" for zero/falsy values. Used by stats cards where the value is already a number.
 */
export function formatBytesNum(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
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
 * Format a date string as a short relative time: "Today", "2d ago", "3w ago".
 */
export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay === 0) {
    if (diffHour > 0) return `${diffHour}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "just now";
  }
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}
