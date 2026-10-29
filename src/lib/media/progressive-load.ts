/**
 * Two-pass loading for the big library list views.
 *
 * These views ask for the whole library (`limit=0`) and virtualise it, so
 * nothing renders until every row has been queried, serialised, transferred and
 * parsed — seconds of skeleton on a large library, to fill a viewport that
 * shows a few dozen rows. Instead: fetch a screenful, paint it, then fetch the
 * remainder with `offset` so nothing is transferred twice.
 *
 * Only for the flat, DB-paginated endpoints (movies / episodes / tracks). The
 * grouped endpoints aggregate the whole library in memory before slicing, so
 * splitting their fetch would run that aggregation twice for no earlier paint.
 */

import { libraryListCache, listCacheKeyFor, type ListCache } from "./list-cache";

/**
 * Rows in the first pass. Comfortably more than a viewport at any card size or
 * table density, so the second pass lands well before the user scrolls past it.
 */
export const FIRST_CHUNK_SIZE = 100;

interface ListResponse<T> {
  items?: T[];
  pagination?: { hasMore?: boolean };
}

/**
 * Fetch `url` in two passes, invoking `onChunk` after each.
 *
 * `onChunk` receives the **full accumulated list** each time (not a delta) so
 * callers can assign it straight to state, plus `done` to distinguish "first
 * screenful, more coming" from "this is everything". Pagination params in
 * `params` are ignored — callers spread user-controlled filters in, and a stray
 * `offset` riding along would silently skip rows out of the first pass.
 *
 * With `quiet`, only the complete list is handed over — for a refresh of a
 * list already on screen. `shownLength` is that list's length: the rest is
 * asked for alongside the first screenful only when the list on screen reaches
 * past it, since for a shorter one the second request would only come back
 * empty after the server had run the whole listing for it.
 *
 * Rejects if the first pass fails. A failed second pass also rejects; without
 * `quiet` the first chunk has already been handed over, so the caller keeps a
 * usable list, while a quiet refresh has handed over nothing and the caller
 * keeps the list it already shows.
 */
export async function fetchListProgressively<T>(
  url: string,
  params: URLSearchParams,
  onChunk: (items: T[], done: boolean) => void,
  {
    cache = libraryListCache,
    quiet = false,
    shownLength,
  }: { cache?: ListCache; quiet?: boolean; shownLength?: number } = {},
): Promise<void> {
  // A list this tab loaded recently is shown whole at once (see
  // `list-cache.ts`); one past fresh is then refreshed behind it through the
  // same two requests a first load makes — the server keeps its answers to
  // those (`withListResponseCache`), and a single `limit=0` request would miss
  // them — and handed over once complete, never as a first screenful after
  // the whole list.
  const listParams = new URLSearchParams(params);
  listParams.delete("offset");
  listParams.delete("page");
  listParams.delete("limit");
  const key = listCacheKeyFor(url, listParams);
  // Read before any request: a clear while one is in flight bumps it, and the
  // answer is then handed to the caller but not stored.
  const generation = cache.generation();
  const cached = cache.get<T[]>(key);
  if (cached) {
    onChunk(cached.value, true);
    if (cached.fresh) return;
    const { items } = await fetchBothPasses<T>(url, params, {
      restAlongside: reachesPastFirstChunk(cached.value.length),
    });
    cache.set(key, items, generation);
    onChunk(items, true);
    return;
  }

  // `quiet`: the page already shows this list and is refreshing it (a sync
  // added or removed items). A first screenful would replace the whole list
  // on screen with its first 100 rows until the rest arrived, so the refresh
  // is handed over once, complete.
  const { items, firstWasAll } = await fetchBothPasses<T>(
    url,
    params,
    quiet ? { restAlongside: reachesPastFirstChunk(shownLength) } : { onFirst: onChunk },
  );
  cache.set(key, items, generation);
  if (quiet || !firstWasAll) onChunk(items, true);
}

/** A list of `length` rows (unknown: assume so) runs past the first screenful. */
function reachesPastFirstChunk(length: number | undefined): boolean {
  return length === undefined || length >= FIRST_CHUNK_SIZE;
}

/**
 * The first screenful, then everything after it. `onFirst` sees the first
 * screenful (with `done` when it was the whole list); the result is the whole
 * list either way.
 *
 * With `restAlongside` nobody is waiting on the first screenful alone (a
 * refresh behind a list already on screen, which runs past it), so the rest is
 * asked for at the same time, from the offset a full first page ends at: one
 * round trip instead of two, through the same two URLs — the keys the server's
 * response cache holds.
 */
async function fetchBothPasses<T>(
  url: string,
  params: URLSearchParams,
  { onFirst, restAlongside = false }: { onFirst?: (items: T[], done: boolean) => void; restAlongside?: boolean } = {},
): Promise<{ items: T[]; firstWasAll: boolean }> {
  const firstParams = new URLSearchParams(params);
  firstParams.delete("offset");
  firstParams.set("page", "1");
  firstParams.set("limit", String(FIRST_CHUNK_SIZE));
  const restUrl = (offset: number) => {
    const restParams = new URLSearchParams(params);
    restParams.delete("page");
    restParams.set("limit", "0");
    restParams.set("offset", String(offset));
    return `${url}?${restParams}`;
  };

  const firstPage = fetchPage<T>(`${url}?${firstParams}`);
  // The early rest can be the whole library; when it goes unused (the first
  // page failed, was the whole list, or ended short of a full page) it is
  // aborted rather than downloaded for nothing.
  const earlyRestAbort = restAlongside && !onFirst ? new AbortController() : undefined;
  const earlyRest = earlyRestAbort ? fetchPage<T>(restUrl(FIRST_CHUNK_SIZE), earlyRestAbort.signal) : undefined;
  // Awaited below, or dropped when the first page turns out to be the whole
  // list; a rejection must not surface as unhandled meanwhile.
  earlyRest?.catch(() => {});

  let firstBody: ListResponse<T>;
  try {
    firstBody = await firstPage;
  } catch (error) {
    earlyRestAbort?.abort();
    throw error;
  }
  const firstItems = firstBody.items ?? [];

  // Trust hasMore when the endpoint sends it; fall back to a short page.
  const hasMore = firstBody.pagination?.hasMore ?? firstItems.length >= FIRST_CHUNK_SIZE;
  onFirst?.(firstItems, !hasMore);
  if (!hasMore) {
    earlyRestAbort?.abort();
    return { items: firstItems, firstWasAll: true };
  }

  // A first page with more after it is always FIRST_CHUNK_SIZE long; one that
  // is not is followed up from its own end rather than leave a gap.
  let restBody: ListResponse<T>;
  if (earlyRest && firstItems.length === FIRST_CHUNK_SIZE) {
    restBody = await earlyRest;
  } else {
    earlyRestAbort?.abort();
    restBody = await fetchPage<T>(restUrl(firstItems.length));
  }
  return { items: [...firstItems, ...(restBody.items ?? [])], firstWasAll: false };
}

async function fetchPage<T>(href: string, signal?: AbortSignal): Promise<ListResponse<T>> {
  const response = await (signal ? fetch(href, { signal }) : fetch(href));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ListResponse<T>;
}
