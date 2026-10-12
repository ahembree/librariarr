/**
 * Do two filter maps hold the same filters?
 *
 * `MediaFilters` re-broadcasts filters a page already holds — the saved filters
 * it restores on mount, the search box re-applying the restored search after
 * its debounce — each time as a new object. Setting state to that object makes
 * the page's fetch callback change and refetch the whole list for filters that
 * did not change, so pages keep their state when this says the two are equal.
 */
export function sameFilters(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}
