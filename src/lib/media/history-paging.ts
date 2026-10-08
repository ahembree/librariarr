/**
 * Paging shared by the History page and `PlayHistory`, which both re-fetch the page
 * on screen whenever plays land, and can find the list shrank under them. Client-safe.
 */

/** The last page of a list of `totalCount` rows; never below 1. */
export function lastPageFor(totalCount: number, pageSize: number): number {
  if (!Number.isFinite(totalCount) || totalCount <= 0 || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

/** `page` brought inside `1..lastPageFor(totalCount)`. */
export function clampPage(page: number, totalCount: number, pageSize: number): number {
  const target = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(1, target), lastPageFor(totalCount, pageSize));
}

/**
 * The page to fetch instead of `requested` when the list now ends before it, else
 * null. Clamps to the new LAST page, not the first, so the user stays near where they were.
 */
export function pageAfterShrink(
  requested: number,
  totalCount: number,
  pageSize: number,
): number | null {
  const clamped = clampPage(requested, totalCount, pageSize);
  return clamped === requested ? null : clamped;
}

/**
 * Request sequencing for a paged list that is also refreshed from outside:
 * - every request takes a new token and only the newest applies, so a refresh
 *   started before a page click cannot land after it and overwrite that page;
 * - a refresh reloads the page last ASKED for — not page 1, and not the page last
 *   shown (that drops a click in flight) — and only a new scope returns to page 1.
 */
export class PageRequestTracker {
  private token = 0;
  private requested = 1;
  private scope: unknown;
  private hasScope = false;

  /** The page most recently requested (what a refresh would reload). */
  get requestedPage(): number {
    return this.requested;
  }

  /** Starts a request for `page`: records it and returns its token. */
  request(page: number): number {
    this.requested = page;
    return ++this.token;
  }

  /** Starts a reload for `scope`: the requested page, or page 1 for a new scope. */
  refresh(scope: unknown): { page: number; token: number } {
    if (!this.hasScope || !Object.is(scope, this.scope)) {
      this.scope = scope;
      this.hasScope = true;
      this.requested = 1;
    }
    const page = this.requested;
    return { page, token: this.request(page) };
  }

  /** Request `token` was answered with the clamped `page`; recorded only if it is the newest. */
  redirect(token: number, page: number): void {
    if (this.isCurrent(token)) this.requested = page;
  }

  /** Whether `token` belongs to the newest request. */
  isCurrent(token: number): boolean {
    return token === this.token;
  }
}

/**
 * What a paged history list renders. Rows on screen always win: a failure keeps them
 * under a Retry notice; the error card is only for a list with nothing to show.
 */
export type PagedListView = "loading" | "error" | "empty" | "rows";

export function pagedListView(state: {
  /** A first load (or a new scope's) with nothing to show yet. */
  loading: boolean;
  error: boolean;
  rowCount: number;
}): PagedListView {
  if (state.rowCount > 0) return "rows";
  if (state.loading) return "loading";
  if (state.error) return "error";
  return "empty";
}

/**
 * The container scrollTop that puts the table's top `margin` px below the container's
 * after a page change (both tops in viewport coordinates), or null when the table's top
 * is already in view: on a short table the jump would move the page for nothing.
 */
export function scrollTopForPageChange(
  anchorTop: number,
  containerTop: number,
  scrollTop: number,
  margin = 16,
): number | null {
  const offset = anchorTop - containerTop;
  if (!Number.isFinite(offset) || offset >= 0) return null;
  return Math.max(0, scrollTop + offset - margin);
}
