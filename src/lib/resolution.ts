/** Canonical display order for resolution labels (highest → lowest). */
export const QUALITY_ORDER = ["4K", "1080P", "720P", "480P", "SD", "Other"] as const;

/**
 * Standard resolution labels used throughout the app for display.
 */
const RESOLUTION_LABELS: Record<string, string> = {
  "4k": "4K",
  "2160": "4K",
  "2160p": "4K",
  "1080": "1080P",
  "1080p": "1080P",
  "720": "720P",
  "720p": "720P",
  "480": "480P",
  "480p": "480P",
  "360": "SD",
  "360p": "SD",
  sd: "SD",
};

/**
 * Normalizes a raw resolution string to a standard display label.
 * Handles both standard values ("1080", "4k") and non-standard pixel heights
 * ("1024p", "872p", "536p") by mapping to the nearest standard resolution.
 *
 * Returns: "4K", "1080P", "720P", "480P", "SD", or "Other"
 */
export function normalizeResolutionLabel(resolution: string | null | undefined): string {
  if (!resolution) return "Other";
  const lower = resolution.toLowerCase().replace("p", "");
  const known = RESOLUTION_LABELS[lower];
  if (known) return known;

  // Handle non-standard numeric resolutions (e.g., "1024", "872", "536")
  const height = parseInt(lower, 10);
  if (!isNaN(height)) {
    if (height >= 2000) return "4K";
    if (height >= 900) return "1080P";
    if (height >= 600) return "720P";
    if (height >= 300) return "480P";
    return "SD";
  }

  return "Other";
}

/**
 * Maps raw video dimensions to Plex-compatible resolution labels for DB storage.
 * Uses width as primary signal (more stable across aspect ratios — a 2.40:1 movie
 * at 1080p has width 1920 but height only ~800).
 *
 * Returns: "4k", "1080", "720", "480", "sd", or undefined
 */
export function normalizeResolutionFromDimensions(
  width?: number,
  height?: number
): string | undefined {
  // Width-based classification (preferred)
  if (width) {
    if (width >= 3000) return "4k";
    if (width >= 1600) return "1080";
    if (width >= 1000) return "720";
    if (width >= 600) return "480";
    return "sd";
  }
  // Height-based fallback
  if (height) {
    if (height >= 2000) return "4k";
    if (height >= 900) return "1080";
    if (height >= 600) return "720";
    if (height >= 300) return "480";
    return "sd";
  }
  return undefined;
}

/**
 * SQL twin of `normalizeResolutionLabel()` for raw aggregate queries.
 *
 * `expr` is the column expression to label (e.g. `mi.resolution`). It
 * mirrors the TS function step for step — lower-case, drop the FIRST `p`,
 * look the result up, else read the leading digits the way `parseInt` does
 * (`"1080i"` → 1080, `"abc"` → none) — because two hand-copied CASEs used to
 * live in the series routes and drifted from it and from each other (one had
 * 1080/720/480 cut-offs against the helper's 900/600/300, so a show's chips
 * disagreed with its seasons'). `tests/integration/media/resolution-label-sql.test.ts`
 * runs this CASE against the TS function over the same inputs.
 */
export function resolutionLabelSql(expr: string): string {
  // LOWER + first-`p` removal, as `resolution.toLowerCase().replace("p", "")`.
  const key = `regexp_replace(LOWER(${expr}), 'p', '')`;
  // Leading digits after optional whitespace, as `parseInt` reads them; capped
  // so the cast cannot overflow.
  const height = `CAST(LEFT(substring(${key} from '^\\s*([0-9]+)'), 15) AS BIGINT)`;
  return `CASE
    WHEN ${expr} IS NULL OR ${expr} = '' THEN 'Other'
    WHEN ${key} IN ('4k', '2160') THEN '4K'
    WHEN ${key} = '1080' THEN '1080P'
    WHEN ${key} = '720' THEN '720P'
    WHEN ${key} = '480' THEN '480P'
    WHEN ${key} IN ('360', 'sd') THEN 'SD'
    WHEN ${key} ~ '^\\s*[0-9]' THEN
      CASE
        WHEN ${height} >= 2000 THEN '4K'
        WHEN ${height} >= 900 THEN '1080P'
        WHEN ${height} >= 600 THEN '720P'
        WHEN ${height} >= 300 THEN '480P'
        ELSE 'SD'
      END
    ELSE 'Other'
  END`;
}
