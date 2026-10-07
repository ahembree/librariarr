/**
 * Page arithmetic shared by the two paged watch-history lists — the History
 * page (`/library/history`) and `PlayHistory` on the detail pages. Both
 * re-fetch the page the user is on whenever new plays land (a sync, a
 * Tracearr backfill slice), and the list can shrink under them between
 * requests, so both need the same answer to "which page do I show now?".
 * Client-safe and pure so it is unit-tested.
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
 * After fetching `requested`, the page to fetch instead because the list now
 * ends before it — or `null` when `requested` still exists and its response
 * can be shown as-is. Clamps to the new LAST page rather than jumping to the
 * first: a refresh that trims a few plays off the end should leave the user
 * next to where they were, not throw them back to the top.
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
 * Request sequencing for a paged list that is also refreshed from the outside
 * (a realtime event, a parent's `refreshKey`). Two rules, both learned the hard
 * way on the watch-history lists:
 *
 * - **Every request takes a new token, and only the newest may apply.** A page
 *   click that reused the in-flight token let a refresh started before it land
 *   afterwards and overwrite the page the user had just moved to.
 * - **A refresh reloads the page last ASKED for, not page 1, and not the page
 *   last shown.** Resetting to page 1 threw the user back to the top on every
 *   `sync:completed` / `watch-history:updated` — every few minutes during a
 *   Tracearr backfill. Reloading the last page SHOWN instead loaded the old page
 *   under new filters when a refresh landed mid filter change, or swallowed a
 *   page click still in flight. Only a change of scope (filters, sort, the
 *   series being shown) goes back to page 1.
 *
 * Plain mutable object, held once per component (`useState(() => new …)`).
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

  /**
   * Starts a reload for `scope`: the requested page when the scope is the one
   * last seen, page 1 when it changed (or on the first call).
   */
  refresh(scope: unknown): { page: number; token: number } {
    if (!this.hasScope || !Object.is(scope, this.scope)) {
      this.scope = scope;
      this.hasScope = true;
      this.requested = 1;
    }
    const page = this.requested;
    return { page, token: this.request(page) };
  }

  /**
   * The request `token` was answered with `page` instead of the page it asked
   * for (the list shrank and the page was clamped). Recorded only while that
   * request is still the newest, so a later refresh reloads the page shown.
   */
  redirect(token: number, page: number): void {
    if (this.isCurrent(token)) this.requested = page;
  }

  /** Whether `token` belongs to the newest request. */
  isCurrent(token: number): boolean {
    return token === this.token;
  }
}

/**
 * What a paged history list renders, from its load state. Rows already on
 * screen always win: a failed refresh or page click keeps them (with a notice
 * and a Retry beside them) instead of replacing them with an error card — the
 * card, which carries its own Retry, is only for a list with nothing to show.
 * `PlayHistory` used to let any failure replace its rows with "Could not load
 * watch history" and no pagination or way to try again.
 */
export type PagedListView = "loading" | "error" | "empty" | "rows";

export function pagedListView(state: {
  /** A first load (or a new scope's) with nothing to show yet. */
  loading: boolean;
  /** The most recent request failed. */
  error: boolean;
  rowCount: number;
}): PagedListView {
  if (state.rowCount > 0) return "rows";
  if (state.loading) return "loading";
  if (state.error) return "error";
  return "empty";
}

/**
 * Where to scroll a list's scroll container after the user moves to another
 * page, so the new page is read from its first row. `anchorTop` is the table's
 * top and `containerTop` the container's, both viewport coordinates
 * (`getBoundingClientRect().top`); `scrollTop` is the container's.
 *
 * Returns `null` — leave the scroll alone — when the table's top is already in
 * view: on a short table the pagination sits a few rows under the header, and
 * jumping there would move the page for nothing. Otherwise the scrollTop that
 * puts the anchor `margin` px below the container's top edge.
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
