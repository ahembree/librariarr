/** One month of a library tile's growth sparkline. */
export interface SparkPoint {
  /** Month bucket label from the timeline API ("YYYY-MM"). */
  date: string;
  total: number;
}

function monthLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Extend a month series through the current month. The timeline API fills
 * gaps only between its first and last non-empty buckets, so without this a
 * library that added nothing recently charted the months ending at its last
 * addition under a "last 12mo" caption. `carry` repeats the last value (a
 * running size) instead of padding with zero additions.
 */
export function extendToCurrentMonth(
  points: SparkPoint[],
  carry: boolean,
  now: Date = new Date(),
): SparkPoint[] {
  if (points.length === 0) return points;
  const current = monthLabel(now);
  const last = points[points.length - 1];
  const [y, m] = last.date.split("-").map(Number);
  if (!y || !m) return points;
  const out = [...points];
  const cursor = new Date(y, m - 1, 1);
  // Bounded so a malformed far-past label cannot loop for long.
  for (let i = 0; i < 1200; i++) {
    cursor.setMonth(cursor.getMonth() + 1);
    const label = monthLabel(cursor);
    if (label > current) break;
    out.push({ date: label, total: carry ? last.total : 0 });
  }
  return out;
}

/**
 * Turn a timeline API response into a tile's sparkline: the last `months`
 * calendar months ending at the current one. `cumulative` (the totals tile)
 * charts a running sum taken over the FULL history before slicing, so the
 * window starts from the true size at its first month and the last point
 * matches the tile's headline total.
 */
export function buildSparkPoints(
  raw: { date: string; total: number }[],
  { cumulative, months, now }: { cumulative: boolean; months: number; now?: Date },
): SparkPoint[] {
  let points = raw.map((p) => ({ date: p.date, total: p.total }));
  if (cumulative) {
    let cum = 0;
    points = points.map((p) => ({ date: p.date, total: (cum += p.total) }));
  }
  return extendToCurrentMonth(points, cumulative, now).slice(-months);
}
