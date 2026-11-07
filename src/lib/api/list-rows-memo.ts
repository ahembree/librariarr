import { appCache } from "@/lib/cache/memory-cache";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import { listingParams } from "@/lib/media/paged-list";
import { sortedQueryString } from "@/lib/sorted-query";

/**
 * A listing's sorted rows, kept between the page requests of one listing.
 *
 * A grouped listing (shows, seasons, artists, albums) has to aggregate the
 * whole library to sort its groups by an aggregate (episode count, size, last
 * play) before it can cut a page, and the movies listing under a track-count
 * filter has to check every candidate's tracks. The library pages ask for a
 * listing one page at a time as the user scrolls, so without this every page
 * redid the whole listing's work to keep 100 of its rows. The rows are kept
 * for a minute under `LIST_RESPONSE_CACHE_PREFIX`, so `invalidateMediaCaches()`
 * drops them with the finished responses; identical concurrent requests share
 * one run (`appCache.getOrSet`).
 */

/** As long as a finished listing response is kept. */
export const LIST_ROWS_MEMO_TTL_MS = 60_000;

/**
 * How many listings' rows are kept at once: enough for every library page
 * plus a filter or two, while a search typed letter by letter cycles through
 * it instead of growing.
 */
export const LIST_ROWS_MEMO_MAX_ENTRIES = 8;

/**
 * A listing whose rows come to more than this (estimated as JSON) is answered
 * but not kept: one huge library must not hold tens of MB of row objects on a
 * small host, beside the listing response cache's own bytes.
 */
export const LIST_ROWS_MEMO_MAX_BYTES = 8 * 1024 * 1024;

/** What every kept listing may hold together (estimated as JSON); past it the oldest go. */
export const LIST_ROWS_MEMO_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/** `media-list:rows:<name>?<sorted query without the page parameters>` (`listingParams`, the pages' own rule). */
export function listRowsKey(name: string, searchParams: URLSearchParams): string {
  return `${LIST_RESPONSE_CACHE_PREFIX}rows:${name}?${sortedQueryString(listingParams(searchParams))}`;
}

/** Rows sampled to estimate a listing's size. */
const SIZE_SAMPLE = 64;

/**
 * The approximate JSON size of a kept value: the arrays in it (the value
 * itself, or its array-valued fields), each from an even sample of its rows.
 * Exact sizing would serialise the whole listing on every compute.
 */
export function estimateRowsBytes(value: unknown): number {
  const arrays = Array.isArray(value)
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).filter(Array.isArray)
      : [];
  let bytes = 0;
  for (const rows of arrays as unknown[][]) {
    if (rows.length === 0) continue;
    const step = Math.max(1, Math.floor(rows.length / SIZE_SAMPLE));
    let sampled = 0;
    let sampleBytes = 0;
    for (let i = 0; i < rows.length; i += step) {
      sampleBytes += sizeOfRow(rows[i]);
      sampled++;
    }
    bytes += Math.ceil((sampleBytes / sampled) * rows.length);
  }
  return bytes;
}

/** One row's JSON length; a row JSON cannot hold (a BigInt) counts as a typical row. */
function sizeOfRow(row: unknown): number {
  try {
    return JSON.stringify(row ?? null)?.length ?? 4;
  } catch {
    return 512;
  }
}

/**
 * The keys kept, oldest first, with each one's estimated size, so the oldest
 * go past either bound. Pinned to `globalThis` like `appCache` itself, so
 * every module copy bounds one set.
 */
const globalForRows = globalThis as unknown as { listRowsMemoSizes: Map<string, number> | undefined };
const keptSizes = (globalForRows.listRowsMemoSizes ??= new Map<string, number>());

function remember(key: string, bytes: number): void {
  keptSizes.delete(key);
  keptSizes.set(key, bytes);
  // Keys whose entry is already gone (invalidated or expired) hold nothing.
  for (const kept of keptSizes.keys()) {
    if (kept !== key && appCache.get(kept) === undefined) keptSizes.delete(kept);
  }
  let total = 0;
  for (const size of keptSizes.values()) total += size;
  while (keptSizes.size > 1 && (keptSizes.size > LIST_ROWS_MEMO_MAX_ENTRIES || total > LIST_ROWS_MEMO_MAX_TOTAL_BYTES)) {
    const oldest = keptSizes.keys().next().value;
    if (oldest === undefined) break;
    total -= keptSizes.get(oldest) ?? 0;
    keptSizes.delete(oldest);
    appCache.invalidate(oldest);
  }
}

/**
 * The listing's sorted rows: kept from an earlier page request of the same
 * listing in the last minute, or computed (once for concurrent requests).
 * The rows are shared between requests — a caller must copy a row before
 * changing it.
 */
export async function memoListRows<T>(
  name: string,
  searchParams: URLSearchParams,
  compute: () => Promise<T>,
): Promise<T> {
  const key = listRowsKey(name, searchParams);
  return appCache.getOrSet<T>(key, compute, LIST_ROWS_MEMO_TTL_MS, {
    shouldCache: (value) => {
      const bytes = estimateRowsBytes(value);
      if (bytes > LIST_ROWS_MEMO_MAX_BYTES) return false;
      remember(key, bytes);
      return true;
    },
  });
}
