import { describe, it, expect } from "vitest";
import {
  resolveLayout,
  isValidLayout,
  getCardDefinition,
  isCustomCardId,
  MIN_CARD_HEIGHT,
  MAX_CARD_HEIGHT,
  type DashboardLayout,
} from "@/lib/dashboard/card-registry";

const bar = { chartType: "bar", dimension: "resolution" };

function layoutWith(main: unknown[]): unknown {
  return { main, movies: [], series: [], music: [] };
}

function resolveMain(main: unknown[]) {
  return resolveLayout(layoutWith(main) as DashboardLayout).main;
}

describe("custom card config validation (via resolveLayout)", () => {
  it.each([
    ["null config", null],
    ["non-object config", "bar"],
    ["unknown chart type", { chartType: "donut", dimension: "resolution" }],
    ["unknown dimension", { chartType: "bar", dimension: "mood" }],
    ["non-string title", { ...bar, title: 5 }],
    ["unknown icon", { ...bar, icon: "NotAnIcon" }],
    ["topN below 1", { ...bar, topN: 0 }],
    ["string topN", { ...bar, topN: "5" }],
    ["unknown heatmap gradient", { ...bar, heatmapGradient: "rainbow" }],
    ["countValues not an array", { ...bar, countValues: "4K" }],
    ["countValues with a number", { ...bar, countValues: ["4K", 2] }],
    ["heatmap without a second dimension", { chartType: "heatmap", dimension: "resolution" }],
    ["heatmap with the same dimension twice", { chartType: "heatmap", dimension: "resolution", dimension2: "resolution" }],
    ["timeline on a non-date dimension", { chartType: "timeline", dimension: "resolution", timelineBin: "month" }],
    ["timeline without a bin", { chartType: "timeline", dimension: "addedAt" }],
    ["timeline with an unknown bin", { chartType: "timeline", dimension: "addedAt", timelineBin: "decade" }],
    ["timeline with an unknown breakdown", { chartType: "timeline", dimension: "addedAt", timelineBin: "month", dimension2: "mood" }],
  ])("drops a custom card with %s", (_label, config) => {
    expect(resolveMain([{ id: "custom-1", size: 6, config }])).toEqual([]);
  });

  it.each([
    ["all optional fields", { ...bar, title: "T", icon: "Film", topN: null, heatmapGradient: "blue", countValues: ["4K"] }],
    ["a heatmap with two dimensions", { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" }],
    ["a timeline with a breakdown", { chartType: "timeline", dimension: "addedAt", timelineBin: "week", dimension2: "resolution" }],
    ["a timeline without a breakdown", { chartType: "timeline", dimension: "lastPlayedAt", timelineBin: "year" }],
    ["a positive topN", { ...bar, topN: 10 }],
  ])("keeps a custom card with %s", (_label, config) => {
    const [entry] = resolveMain([{ id: "custom-1", size: 6, config }]);
    expect(entry).toEqual({ id: "custom-1", size: 6, config });
  });
});

describe("resolveLayout custom card sizing and heights", () => {
  it("defaults a custom card with no numeric size and clamps out-of-range sizes", () => {
    const main = resolveMain([
      { id: "custom-a", config: bar },
      { id: "custom-b", size: 99, config: bar },
      { id: "custom-c", size: 0, config: bar },
    ]);
    expect(main.map((e) => e.size)).toEqual([6, 12, 2]);
  });

  it("clamps and rounds heights, ignoring non-finite values", () => {
    const main = resolveMain([
      { id: "custom-a", size: 6, heightPx: 10, config: bar },
      { id: "custom-b", size: 6, heightPx: 5000, config: bar },
      { id: "custom-c", size: 6, heightPx: 333.6, config: bar },
      { id: "custom-d", size: 6, heightPx: Number.NaN, config: bar },
      { id: "stats", size: 12, heightPx: "400" },
      { id: "top-played", size: 12, heightPx: 450 },
    ]);
    expect(main.map((e) => e.heightPx)).toEqual([MIN_CARD_HEIGHT, MAX_CARD_HEIGHT, 334, undefined, undefined, 450]);
    expect(main[3]).not.toHaveProperty("heightPx");
  });

  it("skips entries without a string id and uses the default size for a non-numeric static size", () => {
    const main = resolveMain([{ size: 6 }, { id: 7, size: 6 }, { id: "stats", size: "big" }]);
    expect(main).toEqual([{ id: "stats", size: 12 }]);
  });

  it("does not deduplicate custom cards that share an id", () => {
    const main = resolveMain([
      { id: "custom-a", size: 6, config: bar },
      { id: "custom-a", size: 6, config: bar },
    ]);
    expect(main).toHaveLength(2);
  });

  it("filters the legacy string format per tab", () => {
    const layout = resolveLayout({
      main: [],
      movies: ["stats", "video-codec", "video-codec", "bogus"],
      series: ["top-played"],
      music: ["genre"],
    } as unknown as DashboardLayout);
    expect(layout.movies).toEqual([{ id: "video-codec", size: 6 }]);
    expect(layout.series).toEqual([]);
    expect(layout.music).toEqual([{ id: "genre", size: 6 }]);
  });

  it("falls back to defaults per tab when a tab is not an array", () => {
    const layout = resolveLayout({ main: [], movies: null, series: "x", music: undefined } as unknown as DashboardLayout);
    const defaults = resolveLayout(null);
    expect(layout.main).toEqual([]);
    expect(layout.movies).toEqual(defaults.movies);
    expect(layout.series).toEqual(defaults.series);
    expect(layout.music).toEqual(defaults.music);
  });
});

describe("isValidLayout", () => {
  it("accepts the default layout", () => {
    expect(isValidLayout(resolveLayout(null))).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "layout"],
    ["a missing tab", { main: [], movies: [], series: [] }],
  ])("rejects %s", (_label, layout) => {
    expect(isValidLayout(layout)).toBe(false);
  });

  it.each([
    ["a null entry", null],
    ["a primitive entry", 5],
    ["a non-string id", { id: 5, size: 6 }],
    ["a non-numeric size", { id: "stats", size: "6" }],
    ["a non-numeric height", { id: "stats", size: 12, heightPx: "300" }],
    ["a height below the minimum", { id: "stats", size: 12, heightPx: MIN_CARD_HEIGHT - 1 }],
    ["a height above the maximum", { id: "stats", size: 12, heightPx: MAX_CARD_HEIGHT + 1 }],
    ["a custom card with an invalid config", { id: "custom-x", size: 6, config: { chartType: "bar" } }],
    ["an unknown card id", { id: "nope", size: 6 }],
  ])("rejects a tab holding %s", (_label, entry) => {
    expect(isValidLayout(layoutWith([entry]))).toBe(false);
  });

  it("rejects a card on a tab it is not allowed on", () => {
    expect(isValidLayout({ main: [], movies: [{ id: "stats", size: 12 }], series: [], music: [] })).toBe(false);
  });

  it("rejects a duplicated static card but allows duplicated custom ids", () => {
    expect(isValidLayout(layoutWith([{ id: "stats", size: 12 }, { id: "stats", size: 12 }]))).toBe(false);
    expect(
      isValidLayout(
        layoutWith([
          { id: "custom-a", size: 6, heightPx: 300, config: bar },
          { id: "custom-a", size: 6, config: bar },
        ]),
      ),
    ).toBe(true);
  });
});

describe("registry helpers", () => {
  it("looks up definitions and recognises custom ids", () => {
    expect(getCardDefinition("genre")?.label).toBe("Genre Breakdown");
    expect(getCardDefinition("missing")).toBeUndefined();
    expect(isCustomCardId("custom-123")).toBe(true);
    expect(isCustomCardId("stats")).toBe(false);
  });
});
