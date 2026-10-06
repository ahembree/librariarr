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
