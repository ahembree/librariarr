import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatFileSize,
  formatBytesNum,
  formatDuration,
  formatDurationClock,
  formatDate,
  formatDateOnly,
  formatRelativeDate,
  formatUntil,
  formatSyncEta,
  formatDateTime,
  formatWatchedAt,
  localDateString,
  toDatetimeLocalValue,
  formatChannels,
} from "@/lib/format";

describe("formatFileSize", () => {
  it("returns '-' for null", () => {
    expect(formatFileSize(null)).toBe("-");
  });

  it("returns '-' for empty string", () => {
    expect(formatFileSize("")).toBe("-");
  });

  it("returns '-' for '0'", () => {
    expect(formatFileSize("0")).toBe("-");
  });

  it("formats bytes (< 1024)", () => {
    expect(formatFileSize("500")).toBe("500 B");
    expect(formatFileSize("1")).toBe("1 B");
  });

  it("formats exactly 1024 bytes as 1 KB", () => {
    expect(formatFileSize("1024")).toBe("1 KB");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize("2048")).toBe("2 KB");
    expect(formatFileSize("512000")).toBe("500 KB");
  });

  it("formats megabytes with 1 decimal", () => {
    // 1 MB = 1,048,576
    expect(formatFileSize("1048576")).toBe("1.0 MB");
    // 500 MB = 524,288,000
    expect(formatFileSize("524288000")).toBe("500.0 MB");
  });

  it("formats gigabytes with 2 decimals", () => {
    // 1 GB = 1,073,741,824
    expect(formatFileSize("1073741824")).toBe("1.00 GB");
    // 2.5 GB
    expect(formatFileSize("2684354560")).toBe("2.50 GB");
  });

  it("formats terabytes with 2 decimals", () => {
    // 1 TB = 1,099,511,627,776
    expect(formatFileSize("1099511627776")).toBe("1.00 TB");
  });

  it("formats petabytes with 2 decimals", () => {
    // 1 PB = 1,125,899,906,842,624
    expect(formatFileSize("1125899906842624")).toBe("1.00 PB");
  });

  it("handles very large file sizes", () => {
    // 5 TB
    expect(formatFileSize("5497558138880")).toBe("5.00 TB");
  });
});

describe("formatBytesNum", () => {
  it("returns '0 B' for zero", () => {
    expect(formatBytesNum(0)).toBe("0 B");
  });

  it("returns '0 B' for negative numbers", () => {
    expect(formatBytesNum(-100)).toBe("0 B");
  });

  it("returns '0 B' for NaN (falsy)", () => {
    expect(formatBytesNum(NaN)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytesNum(500)).toBe("500.0 B");
    expect(formatBytesNum(1)).toBe("1.0 B");
  });

  it("formats exactly 1024 bytes", () => {
    expect(formatBytesNum(1024)).toBe("1.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytesNum(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytesNum(1073741824)).toBe("1.0 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytesNum(1099511627776)).toBe("1.0 TB");
  });

  it("formats fractional values with 1 decimal", () => {
    // 1.5 KB = 1536
    expect(formatBytesNum(1536)).toBe("1.5 KB");
    // 2.5 GB = 2,684,354,560
    expect(formatBytesNum(2684354560)).toBe("2.5 GB");
  });
});

describe("formatDuration", () => {
  it("returns '-' for null", () => {
    expect(formatDuration(null)).toBe("-");
  });

  it("returns '-' for zero", () => {
    expect(formatDuration(0)).toBe("-");
  });

  it("formats minutes only when under 1 hour", () => {
    // 5 minutes = 300,000 ms
    expect(formatDuration(300000)).toBe("5m");
    // 30 minutes = 1,800,000 ms
    expect(formatDuration(1800000)).toBe("30m");
  });

  it("formats exactly 1 minute (60000 ms)", () => {
    expect(formatDuration(60000)).toBe("1m");
  });

  it("formats hours and minutes", () => {
    // 1 hour 30 minutes = 5,400,000 ms
    expect(formatDuration(5400000)).toBe("1h 30m");
    // 2 hours = 7,200,000 ms
    expect(formatDuration(7200000)).toBe("2h 0m");
  });

  it("rounds to nearest minute", () => {
    // 90,500 ms = 1.508 minutes → rounds to 2m
    expect(formatDuration(90500)).toBe("2m");
    // 29,999 ms ≈ 0.5 minutes → rounds to 0m
    expect(formatDuration(29999)).toBe("0m");
  });

  it("handles large durations", () => {
    // 10 hours = 36,000,000 ms
    expect(formatDuration(36000000)).toBe("10h 0m");
  });
});

describe("formatDurationClock", () => {
  it("formats seconds only as M:SS", () => {
    // 0 ms
    expect(formatDurationClock(0)).toBe("0:00");
    // 30 seconds
    expect(formatDurationClock(30000)).toBe("0:30");
  });

  it("formats minutes and seconds as M:SS", () => {
    // 1 minute 5 seconds = 65,000 ms
    expect(formatDurationClock(65000)).toBe("1:05");
    // 10 minutes 30 seconds
    expect(formatDurationClock(630000)).toBe("10:30");
  });

  it("formats hours as H:MM:SS", () => {
    // 1 hour = 3,600,000 ms
    expect(formatDurationClock(3600000)).toBe("1:00:00");
    // 1 hour, 5 minutes, 30 seconds
    expect(formatDurationClock(3930000)).toBe("1:05:30");
    // 2 hours, 30 minutes, 15 seconds
    expect(formatDurationClock(9015000)).toBe("2:30:15");
  });

  it("pads minutes and seconds with leading zeros in hour format", () => {
    // 1 hour, 1 minute, 1 second
    expect(formatDurationClock(3661000)).toBe("1:01:01");
  });

  it("pads seconds with leading zero in minute format", () => {
    // 1 second
    expect(formatDurationClock(1000)).toBe("0:01");
    // 9 seconds
    expect(formatDurationClock(9000)).toBe("0:09");
  });

  it("truncates milliseconds (floors to seconds)", () => {
    // 1999 ms → 1 second
    expect(formatDurationClock(1999)).toBe("0:01");
  });
});

describe("formatDate", () => {
  it("returns '-' for null", () => {
    expect(formatDate(null)).toBe("-");
  });

  it("returns '-' for empty string", () => {
    expect(formatDate("")).toBe("-");
  });

  it("returns custom fallback for null", () => {
    expect(formatDate(null, "N/A")).toBe("N/A");
  });

  it("returns custom fallback for empty string", () => {
    expect(formatDate("", "Unknown")).toBe("Unknown");
  });

  // formatDate renders the instant on the viewer's local calendar (always in
  // en-US), so the inputs are built from local noon: the expected day then
  // holds in every timezone.
  it("formats an ISO date string", () => {
    expect(formatDate(new Date(2024, 0, 15, 12).toISOString())).toBe("January 15, 2024");
  });

  it("formats another date correctly", () => {
    expect(formatDate(new Date(2023, 11, 25, 12).toISOString())).toBe("December 25, 2023");
  });
});

describe("formatDateOnly", () => {
  const origTZ = process.env.TZ;
  afterEach(() => {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  });

  // A release date is a calendar day the sync stores as UTC midnight
  // (`new Date("2010-07-16")`); read in local time it was the day before
  // anywhere west of UTC.
  it.each(["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"])(
    "shows the stored calendar day in %s",
    (tz) => {
      process.env.TZ = tz;
      const stored = new Date("2010-07-16");
      expect(formatDateOnly(stored.toISOString())).toBe("July 16, 2010");
      expect(formatDateOnly(stored)).toBe("July 16, 2010");
      expect(formatDateOnly("2010-07-16", "-", "short")).toBe("Jul 16, 2010");
      expect(formatDateOnly("2023-01-01T00:00:00Z", "-", "short")).toBe("Jan 1, 2023");
    },
  );

  it("keeps formatDate on the local calendar for real instants", () => {
    process.env.TZ = "America/Los_Angeles";
    // 03:00 UTC on the 16th is the evening of the 15th in Los Angeles.
    expect(formatDate("2010-07-16T03:00:00Z")).toBe("July 15, 2010");
  });

  it("returns the fallback for a missing or unreadable value", () => {
    expect(formatDateOnly(null)).toBe("-");
    expect(formatDateOnly(undefined)).toBe("-");
    expect(formatDateOnly("")).toBe("-");
    expect(formatDateOnly(null, "Never")).toBe("Never");
    expect(formatDateOnly("not a date", "N/A")).toBe("N/A");
  });
});

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" to a known date: 2024-06-15T12:00:00.000Z
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for very recent dates", () => {
    // 30 seconds ago
    expect(formatRelativeDate("2024-06-15T11:59:30.000Z")).toBe("just now");
  });

  it("returns 'just now' for a date slightly in the future (server clock ahead)", () => {
    expect(formatRelativeDate("2024-06-15T12:00:03.000Z")).toBe("just now");
    expect(formatRelativeDate("2024-06-16T12:00:00.000Z")).toBe("just now");
  });

  it("returns minutes ago", () => {
    // 5 minutes ago
    expect(formatRelativeDate("2024-06-15T11:55:00.000Z")).toBe("5m ago");
    // 1 minute ago
    expect(formatRelativeDate("2024-06-15T11:59:00.000Z")).toBe("1m ago");
    // 59 minutes ago
    expect(formatRelativeDate("2024-06-15T11:01:00.000Z")).toBe("59m ago");
  });

  it("returns hours ago", () => {
    // 1 hour ago
    expect(formatRelativeDate("2024-06-15T11:00:00.000Z")).toBe("1h ago");
    // 5 hours ago
    expect(formatRelativeDate("2024-06-15T07:00:00.000Z")).toBe("5h ago");
    // 23 hours ago (still same "day" in diff calculation: diffDay = floor(23/24) = 0)
    expect(formatRelativeDate("2024-06-14T13:00:00.000Z")).toBe("23h ago");
  });

  it("returns 'Yesterday' for exactly 1 day ago", () => {
    // 24 hours ago → diffDay = 1
    expect(formatRelativeDate("2024-06-14T12:00:00.000Z")).toBe("Yesterday");
    // 36 hours ago → diffDay = floor(36/24) = 1
    expect(formatRelativeDate("2024-06-14T00:00:00.000Z")).toBe("Yesterday");
  });

  it("returns days ago for 2-6 days", () => {
    // 2 days ago
    expect(formatRelativeDate("2024-06-13T12:00:00.000Z")).toBe("2d ago");
    // 6 days ago
    expect(formatRelativeDate("2024-06-09T12:00:00.000Z")).toBe("6d ago");
  });

  it("returns weeks ago for 7-29 days", () => {
    // 7 days ago → 1w
    expect(formatRelativeDate("2024-06-08T12:00:00.000Z")).toBe("1w ago");
    // 14 days ago → 2w
    expect(formatRelativeDate("2024-06-01T12:00:00.000Z")).toBe("2w ago");
    // 27 days ago → floor(27/7)=3w
    expect(formatRelativeDate("2024-05-19T12:00:00.000Z")).toBe("3w ago");
  });

  it("returns months ago for 30-364 days", () => {
    // 30 days ago → 1mo
    expect(formatRelativeDate("2024-05-16T12:00:00.000Z")).toBe("1mo ago");
    // 90 days ago → 3mo
    expect(formatRelativeDate("2024-03-17T12:00:00.000Z")).toBe("3mo ago");
  });

  it("returns years ago for 365+ days", () => {
    // 365 days ago → 1y
    expect(formatRelativeDate("2023-06-16T12:00:00.000Z")).toBe("1y ago");
    // 730 days ago → 2y
    expect(formatRelativeDate("2022-06-16T12:00:00.000Z")).toBe("2y ago");
  });
});

describe("formatUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" to a known date: 2024-06-15T12:00:00.000Z
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '-' for null (manual-only schedules)", () => {
    expect(formatUntil(null)).toBe("-");
  });

  it("returns 'now' for past dates", () => {
    expect(formatUntil("2024-06-15T11:00:00.000Z")).toBe("now");
  });

  it("returns 'now' for dates less than a minute away", () => {
    expect(formatUntil("2024-06-15T12:00:30.000Z")).toBe("now");
  });

  it("returns minutes for under an hour", () => {
    expect(formatUntil("2024-06-15T12:05:00.000Z")).toBe("in 5m");
    expect(formatUntil("2024-06-15T12:59:00.000Z")).toBe("in 59m");
  });

  it("returns hours for under a day", () => {
    expect(formatUntil("2024-06-15T15:00:00.000Z")).toBe("in 3h");
    expect(formatUntil("2024-06-16T11:00:00.000Z")).toBe("in 23h");
  });

  it("returns days for under a week", () => {
    expect(formatUntil("2024-06-17T12:00:00.000Z")).toBe("in 2d");
    expect(formatUntil("2024-06-21T12:00:00.000Z")).toBe("in 6d");
  });

  it("returns weeks for 7+ days", () => {
    expect(formatUntil("2024-06-22T12:00:00.000Z")).toBe("in 1w");
    expect(formatUntil("2024-06-29T12:00:00.000Z")).toBe("in 2w");
  });
});

describe("formatRelativeDate with largestUnit day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts in days past the first, never weeks or 'Yesterday'", () => {
    const opts = { largestUnit: "day" } as const;
    expect(formatRelativeDate("2024-06-15T11:59:30.000Z", opts)).toBe("just now");
    expect(formatRelativeDate("2024-06-15T11:00:00.000Z", opts)).toBe("1h ago");
    expect(formatRelativeDate("2024-06-14T12:00:00.000Z", opts)).toBe("1d ago");
    expect(formatRelativeDate("2024-05-16T12:00:00.000Z", opts)).toBe("30d ago");
  });

  it("takes a Date as well as a string", () => {
    expect(formatRelativeDate(new Date("2024-06-15T11:55:00.000Z"))).toBe("5m ago");
  });
});

describe("formatSyncEta", () => {
  const start = "2024-06-15T12:00:00.000Z";
  const at = (seconds: number) => new Date(start).getTime() + seconds * 1000;

  it("has no estimate without a rate", () => {
    expect(formatSyncEta(start, 0, 100, at(60))).toBeNull();
    expect(formatSyncEta(start, 10, 0, at(60))).toBeNull();
    expect(formatSyncEta(start, 10, 100, at(4))).toBeNull();
  });

  it("estimates from the rate so far, in seconds, minutes, then hours and minutes", () => {
    // 10 items in 10s, 90 left: 90s.
    expect(formatSyncEta(start, 10, 100, at(10))).toBe("~2m left");
    expect(formatSyncEta(start, 50, 100, at(10))).toBe("~10s left");
    expect(formatSyncEta(start, 10, 1000, at(60))).toBe("~1h 39m left");
  });
});

describe("formatDateTime", () => {
  it("writes the locale's date and time, or the fallback", () => {
    const d = new Date("2024-06-15T12:34:56.000Z");
    expect(formatDateTime(d.toISOString())).toBe(d.toLocaleString());
    expect(formatDateTime(d)).toBe(d.toLocaleString());
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(null, "Never")).toBe("Never");
    expect(formatDateTime("nonsense", "Never")).toBe("Never");
  });
});

describe("formatWatchedAt", () => {
  const now = new Date(2024, 5, 15, 20, 0);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("always carries the clock time", () => {
    const today = new Date(2024, 5, 15, 9, 5);
    const yesterday = new Date(2024, 5, 14, 23, 30);
    const earlier = new Date(2024, 5, 3, 21, 4);
    expect(formatWatchedAt(today.toISOString(), undefined, now)).toBe(`Today ${time(today)}`);
    expect(formatWatchedAt(yesterday, undefined, now)).toBe(`Yesterday ${time(yesterday)}`);
    const day = earlier.toLocaleDateString([], { month: "short", day: "numeric" });
    expect(formatWatchedAt(earlier, undefined, now)).toBe(`${day} ${time(earlier)}`);
  });

  it("adds the year once it is not this one", () => {
    const old = new Date(2022, 0, 2, 8, 0);
    const day = old.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    expect(formatWatchedAt(old, undefined, now)).toBe(`${day} ${time(old)}`);
  });

  it("answers the fallback for a missing or unreadable date", () => {
    expect(formatWatchedAt(null)).toBe("Unknown date");
    expect(formatWatchedAt(null, "-")).toBe("-");
    expect(formatWatchedAt("nope", "-")).toBe("-");
  });
});

describe("local date input values", () => {
  it("writes the date and date-time input formats in local time", () => {
    const d = new Date(2024, 0, 5, 7, 3);
    expect(localDateString(d)).toBe("2024-01-05");
    expect(toDatetimeLocalValue(d)).toBe("2024-01-05T07:03");
  });
});

describe("formatChannels", () => {
  it("names the common layouts, and counts the rest", () => {
    expect(formatChannels(1)).toBe("Mono");
    expect(formatChannels(2)).toBe("Stereo");
    expect(formatChannels(6)).toBe("5.1");
    expect(formatChannels(8)).toBe("7.1");
    expect(formatChannels(4)).toBe("4ch");
  });

  it("spells them out when verbose", () => {
    expect(formatChannels(1, { verbose: true })).toBe("Mono (1.0)");
    expect(formatChannels(2, { verbose: true })).toBe("Stereo (2.0)");
    expect(formatChannels(3, { verbose: true })).toBe("2.1");
    expect(formatChannels(6, { verbose: true })).toBe("5.1 Surround");
    expect(formatChannels(8, { verbose: true })).toBe("7.1 Surround");
    expect(formatChannels(5, { verbose: true })).toBe("5ch");
  });
});
