import { MAX_QUERY_ACTION_ITEMS } from "./constants";
import { normalizeArtistTitle } from "@/lib/media/artist-key";

type BatchMediaType = "MOVIE" | "SERIES" | "MUSIC";

/** Minimal shape needed to batch a query-result selection (a subset of the
 *  page's `QueryResultItem`). */
export interface BatchableItem {
  id: string;
  type: string;
  /** Series name on episode-level rows; used to keep a show's episodes together. */
  parentTitle?: string | null;
  title?: string | null;
  /**
   * Series identity (see src/lib/media/series-key.ts). When present it groups a
   * show's episodes by identity so two same-titled shows aren't batched as one;
   * falls back to the title when absent.
   */
  seriesKey?: string | null;
  /**
   * An episode row's season: a show too big for one request is split at
   * season boundaries, so an Unmonitor that unmonitors whole seasons sees
   * each season's selected episodes in one request (`splitOversizedGroup`).
   */
  seasonNumber?: number | null;
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
 *  collapsed-and-fired once per batch; every other item is its own group.
 *
 *  SERIES items ALWAYS group by show — including the blank-title case. The
 *  server groups a show's episodes by series identity (seriesKey, falling back
 *  to LOWER(TRIM(parentTitle))) and collapses blank-title/keyless series under
 *  a single fallback key, so giving them per-id groups here would split that
 *  server-group across batches and re-introduce the double-fire. */
function groupKey(item: BatchableItem): string {
  if (item.type === "SERIES") {
    const identity =
      item.seriesKey ?? `title:${(item.parentTitle ?? item.title ?? "").trim().toLowerCase()}`;
    return `series:${identity}`;
  }
  // Every Lidarr action acts on the artist, and the server collapses an
  // artist's tracks into one action (collapse-actions.ts) — split across
  // batches, the artist would be acted on once per batch.
  if (item.type === "MUSIC") {
    return `artist:${normalizeArtistTitle(item.parentTitle ?? "")}`;
  }
  return `id:${item.id}`;
}

/**
 * How many actions a run over `items` takes: one per show or artist (the
 * server collapses those), one per movie. Sent with every batch as `runUnits`
 * so the deletion ceiling is checked against the whole run. Two servers' copies
 * of one movie count twice here and once on the server, which only errs toward
 * refusing.
 */
export function countActionUnits(
  items: readonly BatchableItem[],
  targetType: BatchMediaType | null,
): number {
  const keys = new Set<string>();
  for (const item of items) {
    if (targetType && item.type !== targetType) continue;
    keys.add(groupKey(item));
  }
  return keys.size;
}

/**
 * The type of the first show or artist in `items` with more selected rows than
 * fit one request (`size`), or null. Such a group is split across batches by
 * {@link buildActionBatches}, which a whole-record action must not be.
 */
export function oversizedActionGroup(
  items: readonly BatchableItem[],
  targetType: BatchMediaType | null,
  size: number = MAX_QUERY_ACTION_ITEMS,
): "SERIES" | "MUSIC" | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (targetType && item.type !== targetType) continue;
    if (item.type !== "SERIES" && item.type !== "MUSIC") continue;
    const key = groupKey(item);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > size) return item.type;
  }
  return null;
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
 * group larger than `size` (one show or artist with more than `size` selected
 * rows; the page refuses that for a whole-record action) is split across
 * batches — a show a whole season at a time (`splitOversizedGroup`). Groups
 * keep their order, and the batches are a disjoint partition of the retained
 * ids.
 */
export function buildActionBatches(
  items: readonly BatchableItem[],
  targetType: BatchMediaType | null,
  size: number = MAX_QUERY_ACTION_ITEMS,
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`batch size must be a positive integer, got ${size}`);
  }

  // Group items, preserving first-seen order so batches stay stable/contiguous.
  const groups = new Map<string, BatchableItem[]>();
  for (const item of items) {
    if (targetType && item.type !== targetType) continue;
    const key = groupKey(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }

  const batches: string[][] = [];
  let current: string[] = [];
  for (const group of groups.values()) {
    const ids = group.map((item) => item.id);
    if (ids.length > size) {
      // Oversized single group: flush what we have, then split it.
      if (current.length) {
        batches.push(current);
        current = [];
      }
      batches.push(...splitOversizedGroup(group, size));
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

/**
 * One show's (or artist's) rows split into requests of at most `size`. A
 * show's episodes are packed a whole season at a time, so no season straddles
 * two requests — each request's action then sees every selected episode of
 * its seasons, which an Unmonitor that unmonitors whole seasons judges them
 * by. Only a single season larger than `size` is cut. Rows without a season
 * (an artist's tracks) are cut by index.
 */
function splitOversizedGroup(group: readonly BatchableItem[], size: number): string[][] {
  const seasons = new Map<string, string[]>();
  for (const item of group) {
    const key = item.type === "SERIES" && item.seasonNumber != null ? `s${item.seasonNumber}` : "none";
    const ids = seasons.get(key);
    if (ids) ids.push(item.id);
    else seasons.set(key, [item.id]);
  }
  const out: string[][] = [];
  let current: string[] = [];
  for (const ids of seasons.values()) {
    if (current.length + ids.length > size && current.length > 0) {
      out.push(current);
      current = [];
    }
    if (ids.length > size) {
      for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
      continue;
    }
    current.push(...ids);
  }
  if (current.length) out.push(current);
  return out;
}
