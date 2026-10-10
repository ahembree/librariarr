/**
 * Query-param parsing for the paginated media list endpoints.
 *
 * The list routes share one contract: `page` is 1-based, `limit` is clamped to
 * MAX_LIMIT, and `limit=0` means "return everything". `offset` is the escape
 * hatch that makes progressive loading possible — the library views ask for a
 * first screenful, render it, then ask for `limit=0&offset=<first chunk>` to
 * fill in the rest without refetching what they already have. Without it the
 * only way to express "everything after the first N" is to refetch all of it.
 */

/** Upper bound on `limit` for the flat lists. `limit=0` bypasses it entirely. */
export const MAX_LIST_LIMIT = 100;
/**
 * Upper bound on `limit` for the grouped listings (shows, artists), whose rows
 * are aggregates and which the library views page through in larger steps.
 */
export const MAX_GROUPED_LIST_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 50;

/**
 * The largest row offset any list route will ask the database for — the
 * Postgres `integer` bound, which is what both `OFFSET` in raw SQL and Prisma's
 * `skip` validate against. Verified live: `?page=99999999999999999999` on the
 * movies list was a 500 (`PrismaClientValidationError` on `skip`) and on the
 * history list a 500 (`ValueOutOfRange` from `$queryRawUnsafe`'s `OFFSET`),
 * where a page past the end should simply be an empty page. A double past
 * 2^53 also stops being an integer at all, which is what Prisma refused.
 */
export const MAX_SKIP = 2 ** 31 - 1;

/**
 * Bound a row offset to `[0, MAX_SKIP]`. Every `(page - 1) * limit` that feeds
 * a Prisma `skip` or an SQL `OFFSET` must pass through here: an absurd page
 * then reads as an empty page with `hasMore: false`, never as a 500. A NaN
 * reads as 0 — a malformed page is the first page, as the parsers already
 * treat it.
 */
export function clampSkip(skip: number): number {
  if (Number.isNaN(skip)) return 0;
  return Math.min(Math.max(0, Math.trunc(skip)), MAX_SKIP);
}

/**
 * Whether a raw `limit` query value asks for the whole listing.
 *
 * This is THE rule, shared with the API-key guard's request cost — not a
 * string comparison against `"0"`. Every list handler reads `limit` with
 * `parseInt`, which accepts far more spellings of zero than the literal:
 * verified live, `limit=00`, `+0`, `-0`, `0.0`, `0e0`, ` 0` (leading space)
 * and `0abc` each returned the whole library while the guard, comparing the
 * raw string, charged them as one request instead of twenty. `0x` did NOT:
 * `parseInt("0x")` is `NaN` (a hex prefix with no digits), so the handlers
 * fell back to the default page size — which is exactly why the guard has to
 * ask this function rather than keep its own approximation of it.
 */
export function isFullListingLimit(raw: string | null): boolean {
  if (raw === null) return false;
  // `parseInt("-0")` is -0, and `-0 === 0` — a "-0" limit is a full listing.
  return parseInt(raw) === 0;
}

export interface ListPagination {
  /** 1-based page number. */
  page: number;
  /** Page size; 0 means "no limit". */
  limit: number;
  /** Rows to skip — an explicit `offset` when given, else derived from `page`. */
  skip: number;
}

export function parseListPagination(
  searchParams: URLSearchParams,
  { maxLimit = MAX_LIST_LIMIT }: { maxLimit?: number } = {},
): ListPagination {
  // The page is bounded too, so the echoed `pagination.page` is a sane
  // integer rather than the 1e20 the caller typed.
  const page = Math.min(Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1), MAX_SKIP);

  const rawLimitParam = searchParams.get("limit");
  const rawLimit = parseInt(rawLimitParam ?? String(DEFAULT_LIST_LIMIT));
  // A negative limit previously produced a Prisma reverse-take and an
  // always-true hasMore, so clamp to [1, maxLimit] with 0 reserved for "all".
  const limit = isFullListingLimit(rawLimitParam)
    ? 0
    : Math.max(1, Math.min(Number.isNaN(rawLimit) ? DEFAULT_LIST_LIMIT : rawLimit, maxLimit));

  const rawOffset = parseInt(searchParams.get("offset") ?? "");
  const offset = Number.isNaN(rawOffset) ? null : clampSkip(rawOffset);

  return { page, limit, skip: clampSkip(offset ?? (page - 1) * limit) };
}
