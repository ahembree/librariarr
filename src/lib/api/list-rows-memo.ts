import { appCache } from "@/lib/cache/memory-cache";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import { sortedQueryString } from "@/lib/sorted-query";

/**
 * The grouped listings' sorted rows, kept between the page requests of one
 * listing.
 *
 * A grouped listing (shows, seasons, artists, albums) has to aggregate the
 * whole library to sort its groups by an aggregate (episode count, size, last
 * play) before it can cut a page. The library pages ask for a listing one page
 * at a time as the user scrolls, so without this every page re-ran the whole
 * aggregate to keep 100 of its rows. The sorted rows are kept for a minute
 * under `LIST_RESPONSE_CACHE_PREFIX`, so `invalidateMediaCaches()` drops them
 * with the finished responses; identical concurrent requests share one run
 * (`appCache.getOrSet`).
 */

/** As long as a finished listing response is kept. */
export const LIST_ROWS_MEMO_TTL_MS = 60_000;

/**
 * How many listings' rows are kept at once. One entry holds a whole listing's
 * rows (a few MB for the largest libraries), so they get a bound of their own:
 * enough for every library page plus a filter or two, while a search typed
 * letter by letter cycles through it instead of growing.
 */
export const LIST_ROWS_MEMO_MAX_ENTRIES = 8;

/** The parameters that pick a page of a listing, never the listing itself. */
const PAGE_PARAMS = ["page", "limit", "offset", "index"];

/** `media-list:rows:<name>?<sorted query without the page parameters>`. */
export function listRowsKey(name: string, searchParams: URLSearchParams): string {
  const listing = new URLSearchParams(searchParams);
  for (const param of PAGE_PARAMS) listing.delete(param);
  return `${LIST_RESPONSE_CACHE_PREFIX}rows:${name}?${sortedQueryString(listing)}`;
}

/**
 * The keys kept, oldest first, so the oldest goes past the bound. Pinned to
 * `globalThis` like `appCache` itself, so every module copy bounds one set.
 */
const globalForRows = globalThis as unknown as { listRowsMemoKeys: Set<string> | undefined };
const keptKeys = (globalForRows.listRowsMemoKeys ??= new Set<string>());

function remember(key: string): void {
  keptKeys.delete(key);
  keptKeys.add(key);
  // Keys whose entry is already gone (invalidated or expired) hold nothing.
  for (const kept of keptKeys) {
    if (kept !== key && appCache.get(kept) === undefined) keptKeys.delete(kept);
  }
  while (keptKeys.size > LIST_ROWS_MEMO_MAX_ENTRIES) {
    const oldest = keptKeys.values().next().value;
    if (oldest === undefined) break;
    keptKeys.delete(oldest);
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
    shouldCache: () => {
      remember(key);
      return true;
    },
  });
}
