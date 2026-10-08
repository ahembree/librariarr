import { describe, it, expect } from "vitest";
import {
  PageRequestTracker,
  clampPage,
  lastPageFor,
  pageAfterShrink,
  pagedListView,
  scrollTopForPageChange,
} from "@/lib/media/history-paging";

describe("page arithmetic", () => {
  it("never reports a last page below 1, and clamps into range", () => {
    expect([lastPageFor(0, 5), lastPageFor(5, 5), lastPageFor(6, 5)]).toEqual([1, 1, 2]);
    expect([clampPage(0, 50, 5), clampPage(4, 50, 5), clampPage(40, 50, 5), clampPage(3, 0, 5)]).toEqual([1, 4, 10, 1]);
  });

  it("pageAfterShrink keeps a page that still exists, else steps back to the new last page", () => {
    expect([pageAfterShrink(3, 15, 5), pageAfterShrink(1, 0, 5)]).toEqual([null, null]);
    expect([pageAfterShrink(4, 12, 5), pageAfterShrink(9, 0, 5)]).toEqual([3, 1]);
  });
});

describe("PageRequestTracker", () => {
  it("reloads the requested page within a scope, and page 1 in a new one", () => {
    const t = new PageRequestTracker();
    expect(t.refresh("scope-a").page).toBe(1);
    t.request(4);
    expect(t.refresh("scope-a").page).toBe(4);
    expect(t.refresh("scope-b").page).toBe(1);
  });

  it("lets only the newest request apply; a refresh mid-click reloads the page being moved to", () => {
    const t = new PageRequestTracker();
    const first = t.refresh("scope").token;
    const click = t.request(5);
    expect(t.isCurrent(first)).toBe(false);
    expect(t.isCurrent(click)).toBe(true);

    const refresh = t.refresh("scope");
    expect(refresh.page).toBe(5);
    expect(t.isCurrent(click)).toBe(false);
    expect(t.isCurrent(refresh.token)).toBe(true);

    // A click after the refresh started wins over it.
    const next = t.request(2);
    expect(t.isCurrent(refresh.token)).toBe(false);
    expect(t.isCurrent(next)).toBe(true);
  });

  it("records a clamp only for the newest request", () => {
    const t = new PageRequestTracker();
    t.refresh("scope");
    const stale = t.request(9);
    t.request(2);
    t.redirect(stale, 7);
    expect(t.requestedPage).toBe(2);
    const current = t.request(9);
    t.redirect(current, 7);
    expect(t.refresh("scope").page).toBe(7);
  });
});

describe("pagedListView", () => {
  it.each([
    // Rows on screen win over a failed refresh or page click.
    [{ loading: false, error: true, rowCount: 5 }, "rows"],
    [{ loading: false, error: false, rowCount: 3 }, "rows"],
    [{ loading: false, error: true, rowCount: 0 }, "error"],
    [{ loading: true, error: false, rowCount: 0 }, "loading"],
    [{ loading: true, error: true, rowCount: 0 }, "loading"],
    [{ loading: false, error: false, rowCount: 0 }, "empty"],
  ] as const)("%o shows %s", (state, view) => {
    expect(pagedListView(state)).toBe(view);
  });
});

describe("scrollTopForPageChange", () => {
  it.each<[number, number, number, number | null]>([
    // The table's top 1,800px above the container's (at 64px): scroll back up to it.
    [64 - 1800, 64, 2200, 2200 - 1800 - 16],
    // Already in view: leave the scroll alone.
    [300, 64, 0, null],
    [64, 64, 120, null],
    [-10, 0, 5, 0],
    [Number.NaN, 0, 100, null],
  ])("(%d, %d, %d) is %s", (anchorTop, containerTop, scrollTop, expected) => {
    expect(scrollTopForPageChange(anchorTop, containerTop, scrollTop)).toBe(expected);
  });
});
