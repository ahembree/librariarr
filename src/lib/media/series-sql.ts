import { QUALITY_ORDER, resolutionLabelSql } from "@/lib/resolution";

/**
 * SQL fragments shared by the series and season listings so the two cannot
 * drift: both aggregate episode rows with the same "first non-null in episode
 * order" pick for show-level metadata and the same quality-chip buckets.
 */

/**
 * First non-null value of `col` in `orderBy` order — show-level metadata is
 * the same on every episode, so this is "the show's value" with a
 * deterministic tiebreak. `col` and `orderBy` are SQL fragments, never user
 * input.
 */
export function firstNonNullSql(col: string, orderBy: string): string {
  return `(array_agg(${col} ORDER BY ${orderBy}) FILTER (WHERE ${col} IS NOT NULL))[1]`;
}

/**
 * `{ "4K": n, "1080P": n, … }` with zero buckets stripped, over a column that
 * already holds the normalized label (see `resolutionLabelSql`). Generated
 * from `QUALITY_ORDER` so a new bucket lands everywhere at once.
 */
export function qualityCountsSql(labelCol: string): string {
  const pairs = QUALITY_ORDER.map(
    (label) => `'${label}', NULLIF(COUNT(*) FILTER (WHERE ${labelCol} = '${label}'), 0)`,
  );
  return `jsonb_strip_nulls(jsonb_build_object(${pairs.join(", ")}))`;
}

export { resolutionLabelSql };
