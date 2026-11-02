/**
 * A query string with its parameters sorted by name, so the same parameters in
 * another order give the same string. Repeated values of one name keep their
 * order: every handler reads the first (`searchParams.get`), so
 * `limit=100&limit=0` and `limit=0&limit=100` are different requests and
 * sorting by value gave them one cache key. The one rule the
 * library listings' cache keys use on both sides: the browser's list cache
 * (`src/lib/media/list-cache.ts`) and the server's response cache
 * (`src/lib/api/cached-list-response.ts`). Client-safe.
 */
export function sortedQueryString(params: URLSearchParams): string {
  // Array.prototype.sort is stable, so equal names stay in request order.
  const sorted = [...params.entries()].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return new URLSearchParams(sorted).toString();
}
