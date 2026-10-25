/**
 * A query string with its parameters sorted (by name, then value), so the
 * same parameters in another order give the same string. The one rule the
 * library listings' cache keys use on both sides: the browser's list cache
 * (`src/lib/media/list-cache.ts`) and the server's response cache
 * (`src/lib/api/cached-list-response.ts`). Client-safe.
 */
export function sortedQueryString(params: URLSearchParams): string {
  const sorted = [...params.entries()].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
  );
  return new URLSearchParams(sorted).toString();
}
