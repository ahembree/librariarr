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
 * Rejects if the first pass fails. A failed second pass also rejects, but the
 * first chunk has already been handed over, so the caller keeps a usable list.
 */
export async function fetchListProgressively<T>(
  url: string,
  params: URLSearchParams,
  onChunk: (items: T[], done: boolean) => void,
): Promise<void> {
  const firstParams = new URLSearchParams(params);
  firstParams.delete("offset");
  firstParams.set("page", "1");
  firstParams.set("limit", String(FIRST_CHUNK_SIZE));

  const firstResponse = await fetch(`${url}?${firstParams}`);
  if (!firstResponse.ok) throw new Error(`HTTP ${firstResponse.status}`);
  const firstBody = (await firstResponse.json()) as ListResponse<T>;
  const firstItems = firstBody.items ?? [];

  // Trust hasMore when the endpoint sends it; fall back to a short page.
  const hasMore = firstBody.pagination?.hasMore ?? firstItems.length >= FIRST_CHUNK_SIZE;
  onChunk(firstItems, !hasMore);
  if (!hasMore) return;

  const restParams = new URLSearchParams(params);
  restParams.delete("page");
  restParams.set("limit", "0");
  restParams.set("offset", String(firstItems.length));

  const restResponse = await fetch(`${url}?${restParams}`);
  if (!restResponse.ok) throw new Error(`HTTP ${restResponse.status}`);
  const restBody = (await restResponse.json()) as ListResponse<T>;
  onChunk([...firstItems, ...(restBody.items ?? [])], true);
}
