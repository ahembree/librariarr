import { describe, it, expect } from "vitest";
import {
  historyFilterParams,
  historyFiltersActive,
  historyTableView,
  type HistoryListFilters,
} from "@/lib/media/history-filters";

const NONE: HistoryListFilters = {
  search: "",
  serverId: "all",
  types: new Set(),
  usernames: new Set(),
  platforms: new Set(),
  resolutions: new Set(),
};

describe("historyFilterParams", () => {
  it("sends nothing when no filter is set", () => {
    expect(historyFilterParams(NONE)).toEqual([]);
  });

  it("sends each filter as the route reads it, several values pipe-separated", () => {
    expect(
      historyFilterParams({
        search: "boom boom",
        serverId: "srv-1",
        types: new Set(["MOVIE", "SERIES"]),
        usernames: new Set(["alice", "bob"]),
        platforms: new Set(["Roku"]),
        resolutions: new Set(["4K", "Other"]),
      }),
    ).toEqual([
      ["search", "boom boom"],
      ["serverId", "srv-1"],
      ["type", "MOVIE|SERIES"],
      ["username", "alice|bob"],
      ["platform", "Roku"],
      ["resolution", "4K|Other"],
    ]);
  });

  it("sends a whitespace search, as the route searches for it", () => {
    expect(historyFilterParams({ ...NONE, search: " " })).toEqual([["search", " "]]);
  });
});

describe("historyFiltersActive", () => {
  it("is false for the page's initial filters", () => {
    expect(historyFiltersActive(NONE)).toBe(false);
  });

  it.each([
    ["search", { search: "dune" }],
    ["server", { serverId: "srv-1" }],
    ["type", { types: new Set(["MUSIC"]) }],
    ["user", { usernames: new Set(["alice"]) }],
    ["platform", { platforms: new Set(["iOS"]) }],
    ["resolution", { resolutions: new Set(["SD"]) }],
  ] as const)("is true for a %s filter alone", (_name, filter) => {
    expect(historyFiltersActive({ ...NONE, ...filter })).toBe(true);
  });
});

describe("historyTableView", () => {
  const base = {
    loading: false,
    loadError: false,
    rowCount: 0,
    totalCount: 0,
    filtersActive: false,
    historyHasPlays: false,
  };

  it("shows rows whenever there are rows, whatever else is going on", () => {
    expect(historyTableView({ ...base, rowCount: 3, totalCount: 3 })).toBe("table");
    expect(historyTableView({ ...base, rowCount: 3, totalCount: 3, loading: true })).toBe("table");
    // A failed refresh keeps the rows (under a notice), never an empty state.
    expect(historyTableView({ ...base, rowCount: 3, totalCount: 3, loadError: true })).toBe("table");
  });

  it("shows the skeleton while a load with nothing on screen runs, then any failure", () => {
    expect(historyTableView({ ...base, loading: true })).toBe("loading");
    expect(historyTableView({ ...base, loading: true, loadError: true, filtersActive: true, historyHasPlays: true })).toBe("loading");
    expect(historyTableView({ ...base, loadError: true })).toBe("error");
    expect(historyTableView({ ...base, loadError: true, filtersActive: true, historyHasPlays: true })).toBe("error");
  });

  it("keeps the table for a page past the end of a non-empty list", () => {
    expect(historyTableView({ ...base, totalCount: 40 })).toBe("table");
  });

  it("says no plays match when filters exclude a history that has plays", () => {
    expect(historyTableView({ ...base, filtersActive: true, historyHasPlays: true })).toBe("no-matches");
  });

  it("keeps the no-history state for a history that is really empty", () => {
    expect(historyTableView(base)).toBe("no-history");
    // Filters on an empty history: clearing them would change nothing, and
    // Sync Now is the way out.
    expect(historyTableView({ ...base, filtersActive: true })).toBe("no-history");
    // No filters but plays known (the list answered empty anyway): not a
    // filter problem, so no "Clear filters" to offer.
    expect(historyTableView({ ...base, historyHasPlays: true })).toBe("no-history");
  });
});
