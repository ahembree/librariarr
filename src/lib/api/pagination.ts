/**
 * Query-param parsing for the paginated media list endpoints.
 *
 * The list routes share one contract: `page` is 1-based, `limit` is clamped to
 * `maxLimit`, and `limit=0` means "return everything". `offset` is the escape
 * hatch that makes progressive loading possible — the library views ask for a
 * first screenful, render it, then ask for `limit=0&offset=<first chunk>` to
 * fill in the rest without refetching what they already have. Without it the
 * only way to express "everything after the first N" is to refetch all of it.
 */

/** Default upper bound on `limit`. `limit=0` bypasses it entirely. */
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

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
  options?: { maxLimit?: number },
): ListPagination {
  const maxLimit = options?.maxLimit ?? DEFAULT_MAX_LIMIT;

  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);

  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT));
  // A negative limit previously produced a Prisma reverse-take and an
  // always-true hasMore, so clamp to [1, maxLimit] with 0 reserved for "all".
  const limit =
    rawLimit === 0 ? 0 : Math.max(1, Math.min(Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, maxLimit));

  const rawOffset = parseInt(searchParams.get("offset") ?? "");
  const offset = Number.isNaN(rawOffset) ? null : Math.max(0, rawOffset);

  return { page, limit, skip: offset ?? (page - 1) * limit };
}
