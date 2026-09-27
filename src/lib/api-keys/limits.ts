/**
 * How much the public API may destroy, and how fast.
 *
 * Everything an API key can do that ends in media being deleted counts against
 * these: running a deleting action on a rule set's matches (the execute
 * endpoint, or an execution run queued through the API), and removing a
 * lifecycle exception, which is what stops the rules matching an item. The
 * limits hold across every key together.
 *
 * Deliberately fixed rather than a setting. The app's own deletion ceiling
 * (`maxAutoDeleteItems`) is opt-in, because Librariarr exists to delete media
 * unattended and a user whose rules select thousands of items must not be
 * second-guessed. A third-party application is a different case: it runs with
 * no one watching, and a bug or a leaked key in one should never be able to
 * empty a library. Bulk deletion stays possible — from the Pending page, and on
 * the rule set's own schedule — just not through a key.
 *
 * Client-safe (no Node imports, no path aliases): `openapi.ts` quotes these
 * numbers and is imported by the docs build.
 */

/** Items one API request may delete or unprotect. */
export const API_DESTRUCTIVE_PER_REQUEST = 25;

/** Items every API key together may delete or unprotect per rolling hour. */
export const API_DESTRUCTIVE_PER_HOUR = 100;

/** The rolling window `API_DESTRUCTIVE_PER_HOUR` is counted over. */
export const API_DESTRUCTIVE_WINDOW_MS = 60 * 60 * 1000;

/**
 * What one full-listing read costs against a key's 600-requests-a-minute
 * budget: a `limit=0` read of a paged listing, or any read of a listing with
 * no paging (rule matches, action history, exceptions). One returns a whole
 * library — tens of MB, gzipped — where an ordinary page is 50 rows, so
 * counted as one request a leaked read-only key could pull it 600 times a
 * minute. Here rather than in `guard.ts` because `openapi.ts` quotes it.
 */
export const FULL_LISTING_REQUEST_COST = 20;

