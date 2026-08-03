import { prisma } from "@/lib/db";
import type { DimensionMeta } from "@/lib/dashboard/custom-dimensions";

export const ALLOWED_DATE_COLUMNS = new Set(["addedAt", "lastPlayedAt", "originallyAvailableAt"]);
export const VALID_BINS = new Set(["day", "week", "month", "quarter", "year"]);
// What each bucket aggregates: item count, or total file size in bytes.
export const VALID_MEASURES = new Set(["count", "size"]);

export interface TimelinePoint {
  date: string;
  total: number;
  breakdown?: Record<string, number>;
}

function aggregateExpr(measure: string): string {
  // float8 keeps byte sums JSON-serializable (BigInt sums would need
  // string conversion); precision loss is irrelevant at display scale.
  return measure === "size"
    ? `COALESCE(SUM(mi."fileSize"), 0)::float8`
    : `COUNT(*)::int`;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function dateBucketExpr(col: string, bin: string): string {
  switch (bin) {
    case "day":
      return `TO_CHAR(${col}, 'YYYY-MM-DD')`;
    case "week":
      return `TO_CHAR(date_trunc('week', ${col}), 'YYYY-MM-DD')`;
    case "month":
      return `TO_CHAR(${col}, 'YYYY-MM')`;
    case "quarter":
      return `TO_CHAR(${col}, 'YYYY') || '-Q' || EXTRACT(QUARTER FROM ${col})::int`;
    case "year":
      return `TO_CHAR(${col}, 'YYYY')`;
    default:
      return `TO_CHAR(${col}, 'YYYY-MM')`;
  }
}

// Build a SQL expression that maps a dimension's raw DB value to a display label.
// Reuses the same bucketing/mapping patterns from the custom stats route.
function breakdownExpr(meta: DimensionMeta): string | null {
  const col = `mi."${meta.dbField}"`;
  switch (meta.category) {
    case "direct":
      return `COALESCE(${col}::text, '${escapeSqlLiteral(meta.nullLabel)}')`;
    case "value_map":
      // Value mapping is done post-query in code, so just return the raw column
      return `COALESCE(${col}::text, '${escapeSqlLiteral(meta.nullLabel)}')`;
    case "numeric_bucket": {
      if (!meta.bucketConfig) return null;
      const branches: string[] = [`WHEN ${col} IS NULL THEN '${escapeSqlLiteral(meta.nullLabel)}'`];
      for (const [min, max, label] of meta.bucketConfig.ranges) {
        const safe = escapeSqlLiteral(label);
        if (min === null && max !== null) {
          branches.push(`WHEN ${col} < ${max} THEN '${safe}'`);
        } else if (min !== null && max !== null) {
          branches.push(`WHEN ${col} >= ${min} AND ${col} < ${max} THEN '${safe}'`);
        } else if (min !== null && max === null) {
          branches.push(`WHEN ${col} >= ${min} THEN '${safe}'`);
        }
      }
      return `CASE ${branches.join(" ")} END`;
    }
    default:
      // json_unnest, stream_group, date_bucket not supported as breakdown
      return null;
  }
}

// ── Gap filling ─────────────────────────────────────────────────

/** Parse a bucket label back to a Date for iteration */
function parseBucketDate(label: string, bin: string): Date | null {
  switch (bin) {
    case "day":
    case "week": {
      // YYYY-MM-DD
      const [y, m, d] = label.split("-").map(Number);
      if (!y || !m || !d) return null;
      return new Date(y, m - 1, d);
    }
    case "month": {
      // YYYY-MM
      const [y, m] = label.split("-").map(Number);
      if (!y || !m) return null;
      return new Date(y, m - 1, 1);
    }
    case "quarter": {
      // YYYY-Q1..Q4
      const match = label.match(/^(\d{4})-Q(\d)$/);
      if (!match) return null;
      const y = Number(match[1]);
      const q = Number(match[2]);
      return new Date(y, (q - 1) * 3, 1);
    }
    case "year": {
      const y = Number(label);
      if (!y) return null;
      return new Date(y, 0, 1);
    }
    default:
      return null;
  }
}

/** Advance a Date by one bin step */
function advanceBucket(d: Date, bin: string): Date {
  const next = new Date(d);
  switch (bin) {
    case "day":
      next.setDate(next.getDate() + 1);
      break;
    case "week":
      next.setDate(next.getDate() + 7);
      break;
    case "month":
      next.setMonth(next.getMonth() + 1);
      break;
    case "quarter":
      next.setMonth(next.getMonth() + 3);
      break;
    case "year":
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
}

/** Format a Date back to its bucket label */
function formatBucket(d: Date, bin: string): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  switch (bin) {
    case "day":
    case "week":
      return `${y}-${m}-${day}`;
    case "month":
      return `${y}-${m}`;
    case "quarter":
      return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case "year":
      return String(y);
    default:
      return `${y}-${m}`;
  }
}

/** Fill gaps in a points array so every bucket between min and max is present */
function fillGaps(points: TimelinePoint[], bin: string, series: string[]): TimelinePoint[] {
  if (points.length < 2) return points;

  const firstDate = parseBucketDate(points[0].date, bin);
  const lastDate = parseBucketDate(points[points.length - 1].date, bin);
  if (!firstDate || !lastDate) return points;

  const existing = new Map(points.map((p) => [p.date, p]));
  const emptyBreakdown = series.length > 0
    ? Object.fromEntries(series.map((s) => [s, 0]))
    : undefined;

  const filled: TimelinePoint[] = [];
  let cursor = firstDate;
  // Safety limit to prevent infinite loops with bad data
  const maxIter = 5000;
  let iter = 0;

  while (cursor <= lastDate && iter++ < maxIter) {
    const label = formatBucket(cursor, bin);
    const point = existing.get(label);
    if (point) {
      // Ensure all series keys exist (some points may lack certain series)
      if (series.length > 0 && point.breakdown) {
        for (const s of series) {
          if (!(s in point.breakdown)) point.breakdown[s] = 0;
        }
      }
      filled.push(point);
    } else {
      filled.push({ date: label, total: 0, ...(emptyBreakdown ? { breakdown: { ...emptyBreakdown } } : {}) });
    }
    cursor = advanceBucket(cursor, bin);
  }

  return filled;
}

/**
 * Compute a binned time series over one of the date columns. Shared by
 * `GET /api/media/stats/timeline` and the AI analysis `get_timeline` tool.
 * Supports an optional breakdown dimension with top-N + "Other" rollup and
 * gap-filling between the first and last bucket.
 */
export async function computeTimeline(params: {
  dateField: string;
  bin: string;
  measure: string;
  breakdownMeta: DimensionMeta | null;
  serverIds: string[];
  typeFilter: string | null;
  topN: number | null;
  dedupEnabled: boolean;
}): Promise<{ points: TimelinePoint[]; series: string[] }> {
  const { dateField, bin, measure, breakdownMeta, serverIds, typeFilter, topN, dedupEnabled } = params;
  const col = `mi."${dateField}"`;
  const bucketExpr = dateBucketExpr(col, bin);
  const aggExpr = aggregateExpr(measure);

  const typeWhere = typeFilter ? ` AND mi.type = '${escapeSqlLiteral(typeFilter)}'` : "";
  const dedupWhere = dedupEnabled ? ` AND mi."dedupCanonical" = true` : "";

  if (!breakdownMeta) {
    // Simple timeline: just date buckets with aggregated totals
    const rows = await prisma.$queryRawUnsafe<{ date: string; total: number }[]>(
      `SELECT ${bucketExpr} AS "date", ${aggExpr} AS "total"
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l.id
       WHERE l."mediaServerId" = ANY($1)
         AND ${col} IS NOT NULL${typeWhere}${dedupWhere}
       GROUP BY "date"
       ORDER BY "date" ASC`,
      serverIds,
    );

    const points = rows.map((r) => ({ date: r.date, total: r.total }));
    return { points: fillGaps(points, bin, []), series: [] };
  }

  // Timeline with breakdown dimension
  const bExpr = breakdownExpr(breakdownMeta);
  if (!bExpr) {
    // Unsupported breakdown category (json_unnest, stream_group) — fall back to simple
    const rows = await prisma.$queryRawUnsafe<{ date: string; total: number }[]>(
      `SELECT ${bucketExpr} AS "date", ${aggExpr} AS "total"
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l.id
       WHERE l."mediaServerId" = ANY($1)
         AND ${col} IS NOT NULL${typeWhere}${dedupWhere}
       GROUP BY "date"
       ORDER BY "date" ASC`,
      serverIds,
    );
    const points = rows.map((r) => ({ date: r.date, total: r.total }));
    return { points: fillGaps(points, bin, []), series: [] };
  }

  // Query with breakdown
  const rows = await prisma.$queryRawUnsafe<{ date: string; bk: string; cnt: number }[]>(
    `SELECT ${bucketExpr} AS "date", ${bExpr} AS "bk", ${aggExpr} AS "cnt"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       AND ${col} IS NOT NULL${typeWhere}${dedupWhere}
     GROUP BY "date", "bk"
     ORDER BY "date" ASC`,
    serverIds,
  );

  // Apply value mapping if needed
  const mapFn = breakdownMeta.category === "value_map" ? breakdownMeta.valueMapFn : null;

  // Aggregate into points and determine top series
  const seriesTotals = new Map<string, number>();
  const dateMap = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const label = mapFn ? mapFn(row.bk === breakdownMeta.nullLabel ? null : row.bk) : row.bk;
    seriesTotals.set(label, (seriesTotals.get(label) ?? 0) + row.cnt);

    let dateEntry = dateMap.get(row.date);
    if (!dateEntry) {
      dateEntry = new Map<string, number>();
      dateMap.set(row.date, dateEntry);
    }
    dateEntry.set(label, (dateEntry.get(label) ?? 0) + row.cnt);
  }

  // Pick top N series by total count
  let series = [...seriesTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  if (topN !== null && series.length > topN) {
    const topSet = new Set(series.slice(0, topN));
    const newSeries = series.slice(0, topN);

    // Re-aggregate: non-top series become "Other"
    for (const [date, breakdowns] of dateMap) {
      let otherCount = 0;
      for (const [label, count] of breakdowns) {
        if (!topSet.has(label)) {
          otherCount += count;
          breakdowns.delete(label);
        }
      }
      if (otherCount > 0) {
        breakdowns.set("Other", (breakdowns.get("Other") ?? 0) + otherCount);
      }
      dateMap.set(date, breakdowns);
    }
    newSeries.push("Other");
    series = newSeries;
  }

  // Build points
  const seriesSet = new Set(series);
  const points: TimelinePoint[] = [];
  for (const [date, breakdowns] of dateMap) {
    const breakdown: Record<string, number> = {};
    let total = 0;
    for (const [label, count] of breakdowns) {
      if (seriesSet.has(label)) {
        breakdown[label] = count;
        total += count;
      }
    }
    points.push({ date, total, breakdown });
  }

  return { points: fillGaps(points, bin, series), series };
}
