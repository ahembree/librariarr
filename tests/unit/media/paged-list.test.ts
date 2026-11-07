import { describe, it, expect } from "vitest";
import {
  LIST_LOOKAHEAD_ROWS,
  LIST_PAGE_SIZE,
  listingParams,
  pageUrl,
  pagesForRange,
  rowsOf,
  selectListItems,
} from "@/lib/media/paged-list";
import { MAX_GROUPED_LIST_LIMIT, MAX_LIST_LIMIT } from "@/lib/api/pagination";

describe("paged list", () => {
  it("pages within every listing route's cap", () => {
    expect(LIST_PAGE_SIZE).toBeLessThanOrEqual(MAX_LIST_LIMIT);
    expect(LIST_PAGE_SIZE).toBeLessThanOrEqual(MAX_GROUPED_LIST_LIMIT);
    expect(LIST_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("keeps the listing's own parameters and drops every page parameter", () => {
    const listing = listingParams(new URLSearchParams("sortBy=title&limit=0&offset=100&page=3&index=1&genre=Drama"));
    expect(listing.toString()).toBe("sortBy=title&genre=Drama");
  });

  it("asks for the index on the first page only, and never for the whole listing", () => {
    const params = new URLSearchParams("sortBy=title&limit=0&offset=9");
    const first = new URL(pageUrl("/api/media/movies", params, 0), "http://x");
    expect(first.pathname).toBe("/api/media/movies");
    expect(first.searchParams.get("limit")).toBe(String(LIST_PAGE_SIZE));
    expect(first.searchParams.get("offset")).toBe("0");
    expect(first.searchParams.get("index")).toBe("1");
    expect(first.searchParams.get("sortBy")).toBe("title");

    const third = new URL(pageUrl("/api/media/movies", params, 2), "http://x");
    expect(third.searchParams.get("offset")).toBe(String(2 * LIST_PAGE_SIZE));
    expect(third.searchParams.get("index")).toBeNull();
    expect(third.searchParams.getAll("limit")).toEqual([String(LIST_PAGE_SIZE)]);
  });

  it("names the pages a range and its lookahead reach, within the list", () => {
    expect(pagesForRange(0, 10, 1000)).toEqual([0]);
    expect(pagesForRange(120, 180, 1000)).toEqual([0, 1, 2]);
    expect(pagesForRange(150, 160, 1000, { lookahead: 0 })).toEqual([1]);
    // Never past the last page.
    expect(pagesForRange(990, 999, 1000)).toEqual([9]);
    expect(pagesForRange(0, 5, 0)).toEqual([]);
    expect(pagesForRange(10, 5, 100)).toEqual([]);
    expect(LIST_LOOKAHEAD_ROWS).toBeLessThan(LIST_PAGE_SIZE);
  });

  it("lays the loaded pages out at their rows, placeholders between, cut at the total", () => {
    const pages = new Map([
      [0, ["a", "b"]],
      [2, ["e", "f"]],
    ]);
    expect(rowsOf({ index: { total: 5 }, pages }, 2)).toEqual(["a", "b", undefined, undefined, "e"]);
    // A placeholder is a real entry, so `some`/`map` visit it.
    const visited: unknown[] = [];
    rowsOf({ index: { total: 3 }, pages: new Map() }).forEach((row) => visited.push(row));
    expect(visited).toEqual([undefined, undefined, undefined]);
  });

  it("selects a flat listing's rows", () => {
    expect(selectListItems({ items: [1, 2] })).toEqual([1, 2]);
    expect(selectListItems({})).toBeUndefined();
  });
});
