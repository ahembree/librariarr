import { MAX_QUERY_ACTION_ITEMS } from "./constants";

export type BatchMediaType = "MOVIE" | "SERIES" | "MUSIC";

/** Minimal shape needed to batch a query-result selection (a subset of the
 *  page's `QueryResultItem`). */
export interface BatchableItem {
  id: string;
  type: string;
  /** Series name on episode-level rows; used to keep a show's episodes together. */
  parentTitle?: string | null;
  title?: string | null;
}

/** The media family an ad-hoc action targets, derived from its action type
 *  suffix (mirrors the server route). Null for anything without an Arr suffix
 *  (e.g. DO_NOTHING), which the Query UI never sends. */
export function actionMediaType(actionType: string): BatchMediaType | null {
  if (actionType.endsWith("RADARR")) return "MOVIE";
  if (actionType.endsWith("SONARR")) return "SERIES";
  if (actionType.endsWith("LIDARR")) return "MUSIC";
  return null;
}

/** Grouping key used to keep a logical unit inside one request. A series'
 *  episodes share a key (by show) so a whole-record series action isn't
 *  collapsed-and-fired once per batch; every other item is its own group. */
function groupKey(item: BatchableItem): string {
  if (item.type === "SERIES") {
    const show = (item.parentTitle ?? item.title ?? "").trim().toLowerCase();
    if (show) return `series:${show}`;
  }
  return `id:${item.id}`;
}

/**
 * Build the request batches for an ad-hoc query action.
 *
 * The server caps each request at {@link MAX_QUERY_ACTION_ITEMS} ids (a safety
 * bound), so a larger selection is chunked into sequential requests. Two things
 * the naive "slice by index" approach got wrong are handled here:
 *
 * 1. **Family scoping** — only items of `targetType` (the action's media family)
 *    are batched. The server skips the rest anyway, so sending them just inflates
 *    the batch count and fires redundant full-library safety re-queries. Pass
 *    `null` to keep every type (no known family).
 * 2. **Series integrity** — all of a series' selected episodes go in the SAME
 *    batch. The server collapses an episode-level selection to one whole-record
 *    action per series *within a request*; splitting a show across batches would
 *    collapse-and-fire it once per batch (double delete / double count) and hide
 *    excepted episodes from the per-request exception guard.
 *
 * Whole groups are packed greedily into batches of at most `size`. A single
 * group larger than `size` (only reachable for one series with >`size` selected
 * episodes — vanishingly rare) is hard-split across batches. Order is preserved
 * and the batches are a disjoint partition of the retained ids.
 */
export function buildActionBatches(
  items: readonly BatchableItem[],
  targetType: BatchMediaType | null,
  size: number = MAX_QUERY_ACTION_ITEMS,
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`batch size must be a positive integer, got ${size}`);
  }

  // Group ids, preserving first-seen order so batches stay stable/contiguous.
  const groups = new Map<string, string[]>();
  for (const item of items) {
    if (targetType && item.type !== targetType) continue;
    const key = groupKey(item);
    const existing = groups.get(key);
    if (existing) existing.push(item.id);
    else groups.set(key, [item.id]);
  }

  const batches: string[][] = [];
  let current: string[] = [];
  for (const ids of groups.values()) {
    if (ids.length > size) {
      // Oversized single group: flush what we have, then hard-split it.
      if (current.length) {
        batches.push(current);
        current = [];
      }
      for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
      continue;
    }
    if (current.length + ids.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...ids);
  }
  if (current.length) batches.push(current);
  return batches;
}
