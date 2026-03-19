import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatFileSize,
  formatBytesNum,
  formatDuration,
  formatDurationClock,
  formatDate,
  formatRelativeDate,
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

  it("formats an ISO date string", () => {
    // Use a UTC date to avoid timezone issues
    const result = formatDate("2024-01-15T00:00:00.000Z");
    // The exact output depends on the system locale, but should contain "January" and "2024"
    expect(result).toContain("2024");
    expect(result).toContain("January");
  });

  it("formats another date correctly", () => {
    const result = formatDate("2023-12-25T12:00:00.000Z");
    expect(result).toContain("December");
    expect(result).toContain("2023");
    expect(result).toContain("25");
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
