import { describe, it, expect } from "vitest";
import { buildActionBatches, actionMediaType, type BatchableItem } from "@/lib/query/batch";
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
    const showsPerBatch = batches.map((b) => new Set(b.map((id) => id.split("-")[0])));
    // No show appears in more than one batch.
    expect(showsPerBatch[0].has("B") && showsPerBatch[1].has("B")).toBe(false);
    // A fully in one batch, B fully in another.
    expect(batches.flat().filter((id) => id.startsWith("A-"))).toHaveLength(900);
    expect(batches.flat().filter((id) => id.startsWith("B-"))).toHaveLength(600);
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

  it("hard-splits a single show larger than the batch size", () => {
    const batches = buildActionBatches(episodes("Big", 1500), "SERIES", 1000);
    expect(batches.map((b) => b.length)).toEqual([1000, 500]);
  });

  it("partitions a large mixed-show selection into ordered, disjoint batches covering every id", () => {
    const items = [...episodes("A", 700), ...episodes("B", 700), ...episodes("C", 700)];
    const batches = buildActionBatches(items, "SERIES", 1000);
    const flat = batches.flat();
    expect(flat).toHaveLength(2100);
    expect(new Set(flat).size).toBe(2100);
    expect(batches.every((b) => b.length <= 1000)).toBe(true);
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
});
