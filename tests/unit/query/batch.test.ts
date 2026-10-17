import { describe, it, expect } from "vitest";
import { buildActionBatches, actionMediaType, countActionUnits, type BatchableItem } from "@/lib/query/batch";
import { MAX_QUERY_ACTION_ITEMS } from "@/lib/query/constants";

/** N movies as distinct items. */
const movies = (n: number, offset = 0): BatchableItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m-${offset + i}`, type: "MOVIE", title: `Movie ${offset + i}` }));

/** N episodes of one show. */
const episodes = (show: string, n: number, offset = 0): BatchableItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${show}-e${offset + i}`,
    type: "SERIES",
    parentTitle: show,
    title: `${show} S1E${offset + i}`,
  }));

describe("actionMediaType", () => {
  it("maps action-type suffixes to their media family", () => {
    expect(actionMediaType("DELETE_RADARR")).toBe("MOVIE");
    expect(actionMediaType("UNMONITOR_SONARR")).toBe("SERIES");
    expect(actionMediaType("DELETE_FILES_LIDARR")).toBe("MUSIC");
    expect(actionMediaType("DO_NOTHING")).toBeNull();
  });
});

describe("buildActionBatches", () => {
  it("returns no batches for an empty selection", () => {
    expect(buildActionBatches([], "MOVIE", 1000)).toEqual([]);
  });

  it("keeps only items of the target family", () => {
    const items = [...movies(2), ...episodes("Show", 3)];
    const batches = buildActionBatches(items, "MOVIE", 1000);
    expect(batches).toEqual([["m-0", "m-1"]]);
  });

  it("keeps all types when targetType is null", () => {
    const items = [...movies(1), ...episodes("Show", 1)];
    const batches = buildActionBatches(items, null, 1000);
    expect(batches.flat().sort()).toEqual(["Show-e0", "m-0"]);
  });

  it("returns a single batch when the count equals the size exactly", () => {
    const batches = buildActionBatches(movies(1000), "MOVIE", 1000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1000);
  });

  it("splits one item past the size into two batches", () => {
    const batches = buildActionBatches(movies(1001), "MOVIE", 1000);
    expect(batches.map((b) => b.length)).toEqual([1000, 1]);
  });

  it("never splits a show's episodes across a batch boundary", () => {
    // 900 episodes of A then 600 of B: naive index-chunking at 1000 would put
    // 100 of B in batch 1 and 500 in batch 2, firing a whole-record action on B
    // twice. Group-aware packing keeps each show whole.
    const items = [...episodes("A", 900), ...episodes("B", 600)];
    const batches = buildActionBatches(items, "SERIES", 1000);
    // A fully in one batch, B fully in the next.
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(items.slice(0, 900).map((i) => i.id));
    expect(batches[1]).toEqual(items.slice(900).map((i) => i.id));
  });

  it("groups a show's episodes together even when interleaved in the input", () => {
    const items: BatchableItem[] = [];
    for (let i = 0; i < 3; i++) {
      items.push(...episodes("A", 1, i), ...episodes("B", 1, i));
    }
    const batches = buildActionBatches(items, "SERIES", 1000);
    expect(batches).toHaveLength(1);
    // All A episodes precede all B episodes (grouped), not interleaved.
    expect(batches[0]).toEqual(["A-e0", "A-e1", "A-e2", "B-e0", "B-e1", "B-e2"]);
  });

  it("keeps blank-title SERIES items in one batch (matching the server's blank grouping)", () => {
    // Two shows of 600 with two blank-title SERIES rows interleaved. Per-id
    // grouping would pack the blanks as singletons and split them across the
    // 1000 boundary; the server collapses all blank-title series under one ""
    // key, so the client must keep them together or a whole-record action would
    // collapse-and-fire the blank "show" once per batch.
    const items: BatchableItem[] = [
      ...episodes("A", 600),
      { id: "blank1", type: "SERIES", parentTitle: null, title: null },
      ...episodes("B", 600),
      { id: "blank2", type: "SERIES", parentTitle: "", title: "" },
    ];
    const batches = buildActionBatches(items, "SERIES", 1000);
    const batchOf = (id: string) => batches.findIndex((b) => b.includes(id));
    // A (600) + both blanks (2) fill the first batch; B goes in the second.
    expect(batches.map((b) => b.length)).toEqual([602, 600]);
    expect(batchOf("blank1")).toBe(0);
    expect(batchOf("blank2")).toBe(0);
  });

  it("hard-splits a single show larger than the batch size", () => {
    const batches = buildActionBatches(episodes("Big", 1500), "SERIES", 1000);
    expect(batches.map((b) => b.length)).toEqual([1000, 500]);
  });

  it("partitions a large mixed-show selection into ordered, disjoint batches covering every id", () => {
    const items = [...episodes("A", 700), ...episodes("B", 700), ...episodes("C", 700)];
    const batches = buildActionBatches(items, "SERIES", 1000);
    // One show per batch (two would pass 1000), in input order, no id twice.
    expect(batches.map((b) => b.length)).toEqual([700, 700, 700]);
    expect(batches.flat()).toEqual(items.map((i) => i.id));
  });

  it("defaults the size to MAX_QUERY_ACTION_ITEMS", () => {
    const batches = buildActionBatches(movies(MAX_QUERY_ACTION_ITEMS + 1), "MOVIE");
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_QUERY_ACTION_ITEMS);
    expect(batches[1]).toHaveLength(1);
  });

  it("rejects a non-positive or non-integer batch size", () => {
    expect(() => buildActionBatches(movies(5), "MOVIE", 0)).toThrow();
    expect(() => buildActionBatches(movies(5), "MOVIE", -1)).toThrow();
    expect(() => buildActionBatches(movies(5), "MOVIE", 1.5)).toThrow();
  });

  it("groups a show's episodes by seriesKey, splitting two same-titled shows", () => {
    // Both shows are "The Office"; only seriesKey distinguishes them. Each must
    // be its own group so a whole-record action isn't collapsed across them.
    const items: BatchableItem[] = [
      { id: "uk1", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:78107" },
      { id: "us1", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:73244" },
      { id: "us2", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:73244" },
    ];
    // Batch size 2 makes the grouping observable: the UK show (1) and the US
    // show (2) cannot share a batch, so the US episodes start a new one. One
    // title-keyed group of 3 would instead be hard-split as [uk1, us1], [us2].
    const batches = buildActionBatches(items, "SERIES", 2);
    expect(batches).toEqual([["uk1"], ["us1", "us2"]]);
  });

  it("keeps a single show's episodes in one group when seriesKey is shared", () => {
    const items: BatchableItem[] = [
      { id: "e1", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:73244" },
      { id: "uk1", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:78107" },
      { id: "e2", type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:73244" },
    ];
    // Groups are emitted in first-seen order, so e2 joins e1 ahead of the UK
    // show's episode only when the two share a group.
    const batches = buildActionBatches(items, "SERIES", 1000);
    expect(batches).toEqual([["e1", "e2", "uk1"]]);
  });
});

describe("music batching and run size", () => {
  it("keeps an artist's tracks in one batch", () => {
    const items = [
      { id: "t1", type: "MUSIC", parentTitle: "Artist" },
      { id: "m1", type: "MUSIC", parentTitle: "Other" },
      { id: "t2", type: "MUSIC", parentTitle: "artist " },
    ];
    expect(buildActionBatches(items, "MUSIC", 2)).toEqual([["t1", "t2"], ["m1"]]);
  });

  it("counts one action per show or artist and one per movie", () => {
    expect(countActionUnits([
      { id: "e1", type: "SERIES", seriesKey: "tvdb:1" },
      { id: "e2", type: "SERIES", seriesKey: "tvdb:1" },
      { id: "e3", type: "SERIES", seriesKey: "tvdb:2" },
    ], "SERIES")).toBe(2);
    expect(countActionUnits([
      { id: "t1", type: "MUSIC", parentTitle: "A" },
      { id: "t2", type: "MUSIC", parentTitle: "A" },
      { id: "m1", type: "MOVIE" },
    ], "MUSIC")).toBe(1);
    expect(countActionUnits([{ id: "m1", type: "MOVIE" }, { id: "m2", type: "MOVIE" }], "MOVIE")).toBe(2);
  });
});
