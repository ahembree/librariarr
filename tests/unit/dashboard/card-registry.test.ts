import { describe, it, expect } from "vitest";

import {
  resolveLayout,
  getDefaultLayout,
  type DashboardLayout,
} from "@/lib/dashboard/card-registry";

function layoutWith(main: unknown): DashboardLayout {
  return { main, movies: [], series: [], music: [] } as unknown as DashboardLayout;
}

describe("resolveLayout", () => {
  it("returns defaults for a null saved layout", () => {
    expect(resolveLayout(null)).toEqual(getDefaultLayout());
  });

  it("falls back to defaults for a missing or malformed tab", () => {
    const resolved = resolveLayout({ movies: [] } as unknown as DashboardLayout);
    expect(resolved.main).toEqual(getDefaultLayout().main);
    const resolved2 = resolveLayout(layoutWith("nonsense"));
    expect(resolved2.main).toEqual(getDefaultLayout().main);
  });

  it("respects an explicitly empty tab instead of resurrecting defaults", () => {
    // Removing every card must stick — falling back to defaults here put
    // deleted cards back on every render and reload.
    const resolved = resolveLayout(layoutWith([]));
    expect(resolved.main).toEqual([]);
    expect(resolved.movies).toEqual([]);
  });

  it("converts the legacy string[] format with default sizes", () => {
    const resolved = resolveLayout(layoutWith(["stats", "quality-breakdown"]));
    expect(resolved.main).toEqual([
      { id: "stats", size: 12 },
      { id: "quality-breakdown", size: 12 },
    ]);
  });

  it("drops unknown card ids and cards not allowed on the tab", () => {
    const resolved = resolveLayout(
      layoutWith([
        { id: "not-a-card", size: 6 },
        { id: "quality-breakdown", size: 6 },
      ]),
    );
    expect(resolved.main).toEqual([{ id: "quality-breakdown", size: 6 }]);
  });

  it("clamps card sizes into the definition's range", () => {
    const resolved = resolveLayout(layoutWith([{ id: "quality-breakdown", size: 99 }]));
    expect(resolved.main).toEqual([{ id: "quality-breakdown", size: 12 }]);
  });

  it("drops custom cards with invalid configs and keeps valid ones", () => {
    const resolved = resolveLayout(
      layoutWith([
        { id: "custom-bad", size: 6, config: { chartType: "nope" } },
        { id: "custom-ok", size: 6, config: { chartType: "bar", dimension: "genre" } },
      ]),
    );
    expect(resolved.main.map((c) => c.id)).toEqual(["custom-ok"]);
  });

  it("deduplicates repeated card ids", () => {
    const resolved = resolveLayout(
      layoutWith([
        { id: "quality-breakdown", size: 6 },
        { id: "quality-breakdown", size: 12 },
      ]),
    );
    expect(resolved.main).toHaveLength(1);
  });
});
