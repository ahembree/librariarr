import { describe, it, expect } from "vitest";
import {
  MAX_HIDDEN_VALUES,
  clearTypePicks,
  effectiveCardType,
  isValidCardDisplay,
  normalizeCardDisplay,
  toggleHiddenValue,
  withDisplay,
} from "@/lib/dashboard/card-display";
import { isValidLayout, resolveLayout, type DashboardLayout } from "@/lib/dashboard/card-registry";

describe("withDisplay", () => {
  it("stores only what differs from the defaults", () => {
    expect(withDisplay(undefined, { view: undefined, topN: 5, hidden: [] })).toBeUndefined();
    expect(withDisplay(undefined, { view: "donut", topN: 10 })).toEqual({ view: "donut", topN: 10 });
    expect(withDisplay(undefined, { topN: null })).toEqual({ topN: null });
  });

  it("clears a key the patch sets to undefined and keeps the rest", () => {
    const current = { view: "donut" as const, type: "MOVIE" as const, hidden: ["4K"] };
    expect(withDisplay(current, { type: undefined })).toEqual({ view: "donut", hidden: ["4K"] });
    expect(withDisplay(current, { view: undefined, type: undefined, hidden: [] })).toBeUndefined();
    expect(withDisplay(current, { topN: 20 })).toEqual({ ...current, topN: 20 });
  });
});

describe("isValidCardDisplay", () => {
  it("accepts every field in range", () => {
    expect(isValidCardDisplay({})).toBe(true);
    expect(isValidCardDisplay({ view: "donut", topN: null, type: "ALL", hidden: ["a", "b"] })).toBe(true);
    for (const topN of [5, 10, 15, 20]) expect(isValidCardDisplay({ topN })).toBe(true);
  });

  it("refuses unknown keys, values out of range and non-objects", () => {
    for (const bad of [
      null, "donut", ["donut"], { view: "bars" }, { topN: 0 }, { topN: "5" }, { type: "movie" },
      { hidden: "4K" }, { hidden: [""] }, { hidden: [1] }, { hidden: ["x".repeat(101)] },
      { hidden: Array.from({ length: MAX_HIDDEN_VALUES + 1 }, (_, i) => `v${i}`) }, { extra: true },
    ]) {
      expect(isValidCardDisplay(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("normalizeCardDisplay", () => {
  it("keeps the well-formed fields and drops the rest", () => {
    expect(normalizeCardDisplay({ view: "pie", topN: 10, type: "SERIES", hidden: ["a", "a", 3, "", "b"], x: 1 }))
      .toEqual({ topN: 10, type: "SERIES", hidden: ["a", "b"] });
    expect(normalizeCardDisplay({ view: "donut", topN: null })).toEqual({ view: "donut", topN: null });
  });

  it("is undefined for nothing usable", () => {
    expect(normalizeCardDisplay(undefined)).toBeUndefined();
    expect(normalizeCardDisplay("donut")).toBeUndefined();
    expect(normalizeCardDisplay({ view: "bars", topN: 5, hidden: [] })).toBeUndefined();
  });

  it("caps the hidden values", () => {
    const many = Array.from({ length: MAX_HIDDEN_VALUES + 5 }, (_, i) => `v${i}`);
    expect(normalizeCardDisplay({ hidden: many })?.hidden).toHaveLength(MAX_HIDDEN_VALUES);
  });
});

describe("toggleHiddenValue", () => {
  it("adds a value, removes it again, and stops at the cap", () => {
    expect(toggleHiddenValue(undefined, "4K")).toEqual(["4K"]);
    expect(toggleHiddenValue(["4K", "SD"], "4K")).toEqual(["SD"]);
    const full = Array.from({ length: MAX_HIDDEN_VALUES }, (_, i) => `v${i}`);
    expect(toggleHiddenValue(full, "one more")).toEqual(full);
    expect(toggleHiddenValue(full, "v0")).toHaveLength(MAX_HIDDEN_VALUES - 1);
  });
});

describe("effectiveCardType", () => {
  const types = ["MOVIE", "SERIES"];

  it("follows the Insights filter without a pick", () => {
    expect(effectiveCardType(undefined, "MOVIE", types)).toBe("MOVIE");
    expect(effectiveCardType(undefined, undefined, types)).toBeUndefined();
  });

  it("lets a pick override the filter, ALL included", () => {
    expect(effectiveCardType("SERIES", "MOVIE", types)).toBe("SERIES");
    expect(effectiveCardType("ALL", "MOVIE", types)).toBeUndefined();
  });

  it("ignores a pick of a type the library no longer has", () => {
    expect(effectiveCardType("MUSIC", "MOVIE", types)).toBe("MOVIE");
    expect(effectiveCardType("MUSIC", undefined, [])).toBe("MUSIC");
  });
});

describe("clearTypePicks", () => {
  it("drops every pick and keeps the rest of each card", () => {
    const cards = [
      { id: "a", size: 6, display: { type: "MOVIE" as const, view: "donut" as const } },
      { id: "b", size: 6, display: { type: "ALL" as const } },
      { id: "c", size: 6 },
    ];
    const cleared = clearTypePicks(cards);
    expect(cleared).toEqual([
      { id: "a", size: 6, display: { view: "donut" } },
      { id: "b", size: 6 },
      { id: "c", size: 6 },
    ]);
    expect(cleared[2]).toBe(cards[2]);
  });

  it("returns the same array when no card has a pick", () => {
    const cards = [{ id: "a", size: 6, display: { topN: 10 } }];
    expect(clearTypePicks(cards)).toBe(cards);
  });
});

describe("display in the saved layout", () => {
  const layout = (display: unknown) =>
    ({ main: [{ id: "quality-breakdown", size: 6, display }], movies: [], series: [], music: [] }) as unknown as DashboardLayout;

  it("is validated on save and kept on load", () => {
    expect(isValidLayout(layout({ view: "donut", hidden: ["4K"] }))).toBe(true);
    expect(isValidLayout(layout({ view: "pie" }))).toBe(false);
    expect(resolveLayout(layout({ view: "donut", hidden: ["4K"] })).main[0].display).toEqual({ view: "donut", hidden: ["4K"] });
  });

  it("loads a malformed display as what is usable of it", () => {
    expect(resolveLayout(layout({ view: "pie", topN: 10 })).main[0].display).toEqual({ topN: 10 });
    expect(resolveLayout(layout("junk")).main[0]).toEqual({ id: "quality-breakdown", size: 6 });
  });
});
