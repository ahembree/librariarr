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

describe("historyFilterParams / historyFiltersActive", () => {
  it("sends each filter as the route reads it, several values pipe-separated", () => {
    expect(historyFilterParams(NONE)).toEqual([]);
    // A whitespace search is sent, as the route searches for it.
    expect(historyFilterParams({ ...NONE, search: " " })).toEqual([["search", " "]]);
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

  it.each([
    ["no", {}, false],
    ["a search", { search: "dune" }, true],
    ["a server", { serverId: "srv-1" }, true],
    ["a type", { types: new Set(["MUSIC"]) }, true],
    ["a user", { usernames: new Set(["alice"]) }, true],
    ["a platform", { platforms: new Set(["iOS"]) }, true],
    ["a resolution", { resolutions: new Set(["SD"]) }, true],
  ] as const)("is active for %s filter: %s", (_name, filter, active) => {
    expect(historyFiltersActive({ ...NONE, ...filter })).toBe(active);
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

  it.each([
    // Rows on screen win; a failed refresh keeps them under a notice.
    [{ rowCount: 3, totalCount: 3 }, "table"],
    [{ rowCount: 3, totalCount: 3, loading: true }, "table"],
    [{ rowCount: 3, totalCount: 3, loadError: true }, "table"],
    [{ loading: true }, "loading"],
    [{ loading: true, loadError: true, filtersActive: true, historyHasPlays: true }, "loading"],
    [{ loadError: true }, "error"],
    [{ loadError: true, filtersActive: true, historyHasPlays: true }, "error"],
    // A page past the end of a non-empty list.
    [{ totalCount: 40 }, "table"],
    [{ filtersActive: true, historyHasPlays: true }, "no-matches"],
    // A really empty history (clearing filters would change nothing), or no
    // filters at all: Sync Now, not Clear filters.
    [{}, "no-history"],
    [{ filtersActive: true }, "no-history"],
    [{ historyHasPlays: true }, "no-history"],
  ] as const)("%o shows %s", (state, view) => {
    expect(historyTableView({ ...base, ...state })).toBe(view);
  });
});
