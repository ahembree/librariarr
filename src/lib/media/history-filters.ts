/** The History page's list filters: the parameters they send and the view shown. Client-safe. */

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
 * The `GET /api/media/history` parameters, one per active filter. `historyFiltersActive`
 * reads this list, so a filter can never narrow the list without counting as active.
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
 * What the table area shows. `error` only when there are no rows to keep; `no-history`
 * is "No watch history … Sync Now", `no-matches` "No plays match these filters".
 */
export type HistoryTableView = "loading" | "error" | "no-history" | "no-matches" | "table";

export function historyTableView(state: {
  loading: boolean;
  loadError: boolean;
  rowCount: number;
  /** `pagination.totalCount` of the last answer: plays matching the filters. */
  totalCount: number;
  filtersActive: boolean;
  /** Whether the history holds any play, filters aside: the answer's unfiltered `usernames`. */
  historyHasPlays: boolean;
}): HistoryTableView {
  if (state.rowCount > 0) return "table";
  if (state.loading) return "loading";
  if (state.loadError) return "error";
  // A page past the end of a non-empty list keeps the table and its pagination.
  if (state.totalCount > 0) return "table";
  // With plays in the history, an empty answer under filters is the filters' doing:
  // offer Clear filters, not a sync that cannot change the answer.
  return state.filtersActive && state.historyHasPlays ? "no-matches" : "no-history";
}
