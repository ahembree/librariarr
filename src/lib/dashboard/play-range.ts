/**
 * The Top Played card's time-range presets. Absent (`undefined`) is "All
 * Time": the cumulative `playCount` lists the stats payload already carries.
 * A preset ranks by the plays in `WatchHistory` within that rolling window
 * (`GET /api/media/stats/top-played?range=`).
 */

export type PlayRange = "week" | "month" | "3months" | "year";

export const PLAY_RANGE_OPTIONS: readonly { value: PlayRange; label: string; days: number }[] = [
  { value: "week", label: "Last Week", days: 7 },
  { value: "month", label: "Last Month", days: 30 },
  { value: "3months", label: "Last 3 Months", days: 90 },
  { value: "year", label: "Last Year", days: 365 },
];

const DAYS_BY_RANGE = new Map<string, number>(PLAY_RANGE_OPTIONS.map((o) => [o.value, o.days]));

export function isPlayRange(value: unknown): value is PlayRange {
  return typeof value === "string" && DAYS_BY_RANGE.has(value);
}

/** A preset's label, or "All Time" for none. */
export function playRangeLabel(range: PlayRange | undefined): string {
  return PLAY_RANGE_OPTIONS.find((o) => o.value === range)?.label ?? "All Time";
}

/** The start of a preset's window, counted back from `now`. */
export function playRangeSince(range: PlayRange, now: Date = new Date()): Date {
  const days = DAYS_BY_RANGE.get(range) ?? 0;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
