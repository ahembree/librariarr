/**
 * The History page's (`/library/history`) list filters: the query parameters
 * they send, and which view the table area shows. Client-safe and pure so it
 * is unit-tested.
 */

/** The filters as the page holds them. */
export interface HistoryListFilters {
  /** The search the list is FETCHED with — the debounced value, not the box. */
  search: string;
  /** A server id, or `"all"`. */
  serverId: string;
  types: ReadonlySet<string>;
  usernames: ReadonlySet<string>;
  platforms: ReadonlySet<string>;
  resolutions: ReadonlySet<string>;
}

/**
 * The `GET /api/media/history` parameters the filters send, one entry per
 * active filter. `historyFiltersActive` is defined by this list, so a filter
 * can never narrow the list without also counting as active.
 */
export function historyFilterParams(filters: HistoryListFilters): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  if (filters.search) params.push(["search", filters.search]);
  if (filters.serverId !== "all") params.push(["serverId", filters.serverId]);
  if (filters.types.size > 0) params.push(["type", [...filters.types].join("|")]);
  if (filters.usernames.size > 0) params.push(["username", [...filters.usernames].join("|")]);
  if (filters.platforms.size > 0) params.push(["platform", [...filters.platforms].join("|")]);
  if (filters.resolutions.size > 0) params.push(["resolution", [...filters.resolutions].join("|")]);
  return params;
}

/** Whether any filter narrows the list. */
export function historyFiltersActive(filters: HistoryListFilters): boolean {
  return historyFilterParams(filters).length > 0;
}

/**
 * What the table area shows:
 * - `loading` — the skeleton, for a load with nothing on screen yet;
 * - `error` — the failed-load card, only when there are no rows to keep;
 * - `no-history` — "No watch history … Sync Now": nothing has been played;
 * - `no-matches` — "No plays match these filters" with Clear filters;
 * - `table` — the rows (a failed refresh keeps them under a notice).
 */
export type HistoryTableView = "loading" | "error" | "no-history" | "no-matches" | "table";

export function historyTableView(state: {
  loading: boolean;
  loadError: boolean;
  rowCount: number;
  /** `pagination.totalCount` of the last answer: plays matching the filters. */
  totalCount: number;
  filtersActive: boolean;
  /**
   * Whether the history holds any play at all, filters aside — the answer's
   * `usernames`, which the route lists from every stored play regardless of
   * the filters.
   */
  historyHasPlays: boolean;
}): HistoryTableView {
  if (state.rowCount > 0) return "table";
  if (state.loading) return "loading";
  if (state.loadError) return "error";
  // A page past the end of a non-empty list keeps the table (and its
  // pagination) rather than claiming there is nothing to show.
  if (state.totalCount > 0) return "table";
  // An empty answer under filters used to say "No watch history … Sync Now",
  // which told a user with thousands of plays that they had none and offered
  // a sync that could not change the answer. It is that only when the
  // history really is empty; otherwise the filters excluded everything, and
  // clearing them is the way out.
  return state.filtersActive && state.historyHasPlays ? "no-matches" : "no-history";
}
