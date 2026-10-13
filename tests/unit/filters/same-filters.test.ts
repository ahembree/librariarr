import { describe, it, expect } from "vitest";
import { sameFilters } from "@/lib/filters/same-filters";

describe("sameFilters", () => {
  it("is true for the same object and for an equal copy", () => {
    const a = { resolution: "4K|1080P", search: "alien" };
    expect(sameFilters(a, a)).toBe(true);
    expect(sameFilters(a, { search: "alien", resolution: "4K|1080P" })).toBe(true);
    expect(sameFilters({}, {})).toBe(true);
  });

  it("is false when a value, a key or the key count differs", () => {
    expect(sameFilters({ search: "alien" }, { search: "aliens" })).toBe(false);
    expect(sameFilters({ search: "alien" }, { genre: "alien" })).toBe(false);
    expect(sameFilters({ search: "alien" }, { search: "alien", genre: "Horror" })).toBe(false);
    expect(sameFilters({ search: "alien", genre: "Horror" }, { search: "alien" })).toBe(false);
  });

  it("does not count an inherited property as a filter", () => {
    const inherited = Object.create({ search: "alien" }) as Record<string, string>;
    inherited.genre = "Horror";
    expect(sameFilters({ search: "alien" }, inherited)).toBe(false);
  });
});
