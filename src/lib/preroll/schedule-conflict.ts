/**
 * Shared schedule-conflict detection for preroll schedules.
 *
 * Used by both the preroll schedule create (POST) and update (PUT) routes to
 * reject overlapping enabled schedules of the same kind:
 *   - one_time / seasonal: overlapping date ranges
 *   - recurring: a shared day-of-week AND overlapping time-of-day windows
 *
 * Recurring time windows may span midnight (e.g. 22:00–06:00). Such an
 * overnight window is split into two same-day ranges — [start, 24:00) and
 * [00:00, end] — so the overlap test stays correct across the wrap-around.
 */

export interface ScheduleConflictInput {
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

/** Convert an "HH:mm" string to minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Expand an [start, end] daily window into one or two `[start, end]` minute
 * ranges, splitting at midnight when the window is overnight (end <= start).
 */
function toMinuteRanges(startMin: number, endMin: number): [number, number][] {
  if (endMin > startMin) {
    return [[startMin, endMin]];
  }
  // Overnight window (or end === start, treated as wrapping): split at midnight.
  return [
    [startMin, MINUTES_IN_DAY],
    [0, endMin],
  ];
}

/** True if two minute ranges (each [start, end]) overlap. */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && a[1] > b[0];
}

/**
 * True if two daily time windows overlap, correctly handling windows that
 * wrap past midnight.
 */
function timeWindowsOverlap(
  inputStart: number,
  inputEnd: number,
  otherStart: number,
  otherEnd: number,
): boolean {
  const inputRanges = toMinuteRanges(inputStart, inputEnd);
  const otherRanges = toMinuteRanges(otherStart, otherEnd);
  for (const ir of inputRanges) {
    for (const or of otherRanges) {
      if (rangesOverlap(ir, or)) return true;
    }
  }
  return false;
}

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
    if (
      (input.scheduleType === "one_time" || input.scheduleType === "seasonal") &&
      (other.scheduleType === "one_time" || other.scheduleType === "seasonal")
    ) {
      // Date range overlap check
      const inputStart = new Date(input.startDate!);
      const inputEnd = new Date(input.endDate!);
      const otherStart = other.startDate!;
      const otherEnd = other.endDate!;

      if (inputStart < otherEnd && inputEnd > otherStart) {
        return { id: other.id, name: other.name };
      }
    }

    if (input.scheduleType === "recurring" && other.scheduleType === "recurring") {
      // Check day overlap
      const inputDays = new Set(input.daysOfWeek!);
      const otherDays = (other.daysOfWeek as number[]) || [];
      const hasOverlappingDay = otherDays.some((d) => inputDays.has(d));

      if (hasOverlappingDay && other.startTime && other.endTime && input.startTime && input.endTime) {
        // Check time overlap (handles overnight windows)
        const inputStartMin = timeToMinutes(input.startTime);
        const inputEndMin = timeToMinutes(input.endTime);
        const otherStartMin = timeToMinutes(other.startTime);
        const otherEndMin = timeToMinutes(other.endTime);

        if (timeWindowsOverlap(inputStartMin, inputEndMin, otherStartMin, otherEndMin)) {
          return { id: other.id, name: other.name };
        }
      }
    }
  }

  return null;
}
