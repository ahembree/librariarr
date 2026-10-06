import { describe, it, expect } from "vitest";
import {
  PageRequestTracker,
  clampPage,
  lastPageFor,
  pageAfterShrink,
} from "@/lib/media/history-paging";

describe("lastPageFor / clampPage", () => {
  it("never reports a last page below 1", () => {
    expect(lastPageFor(0, 5)).toBe(1);
    expect(lastPageFor(5, 5)).toBe(1);
    expect(lastPageFor(6, 5)).toBe(2);
  });

  it("clamps into range", () => {
    expect(clampPage(0, 50, 5)).toBe(1);
    expect(clampPage(4, 50, 5)).toBe(4);
    expect(clampPage(40, 50, 5)).toBe(10);
    expect(clampPage(3, 0, 5)).toBe(1);
  });
});

describe("pageAfterShrink", () => {
  it("keeps a page that still exists", () => {
    expect(pageAfterShrink(3, 15, 5)).toBeNull();
    expect(pageAfterShrink(1, 0, 5)).toBeNull();
  });

  it("steps back to the new last page, not the first", () => {
    expect(pageAfterShrink(4, 12, 5)).toBe(3);
    expect(pageAfterShrink(9, 0, 5)).toBe(1);
  });
});

describe("PageRequestTracker", () => {
  it("starts a new scope at page 1", () => {
    const t = new PageRequestTracker();
    expect(t.refresh("scope-a").page).toBe(1);
  });

  it("reloads the page the user is on when the scope is unchanged", () => {
    const t = new PageRequestTracker();
    t.refresh("scope-a");
    t.request(4);
    expect(t.refresh("scope-a").page).toBe(4);
  });

  it("goes back to page 1 when the scope changes", () => {
    const t = new PageRequestTracker();
    t.refresh("scope-a");
    t.request(4);
    expect(t.refresh("scope-b").page).toBe(1);
  });

  it("gives every request a new token so only the newest applies", () => {
    const t = new PageRequestTracker();
    const refresh = t.refresh("scope").token;
    const click = t.request(3);
    expect(click).not.toBe(refresh);
    expect(t.isCurrent(refresh)).toBe(false);
    expect(t.isCurrent(click)).toBe(true);
  });

  it("a refresh during an in-flight page change reloads the page being moved to", () => {
    const t = new PageRequestTracker();
    t.refresh("scope");
    const click = t.request(5);
    const { page, token } = t.refresh("scope");
    expect(page).toBe(5);
    expect(t.isCurrent(click)).toBe(false);
    expect(t.isCurrent(token)).toBe(true);
  });

  it("a click after a refresh started wins over that refresh", () => {
    const t = new PageRequestTracker();
    t.refresh("scope");
    const { token: refresh } = t.refresh("scope");
    const click = t.request(2);
    expect(t.isCurrent(refresh)).toBe(false);
    expect(t.isCurrent(click)).toBe(true);
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
