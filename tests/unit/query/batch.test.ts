import { describe, it, expect } from "vitest";
import { batchIds } from "@/lib/query/batch";
import { MAX_QUERY_ACTION_ITEMS } from "@/lib/query/constants";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("batchIds", () => {
  it("returns no batches for an empty selection", () => {
    expect(batchIds([], 1000)).toEqual([]);
  });

  it("returns a single batch when the count is under the size", () => {
    expect(batchIds(ids(3), 1000)).toEqual([["id-0", "id-1", "id-2"]]);
  });

  it("returns a single batch when the count equals the size exactly", () => {
    const batches = batchIds(ids(1000), 1000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1000);
  });

  it("splits one item past the size into two batches", () => {
    const batches = batchIds(ids(1001), 1000);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1000);
    expect(batches[1]).toEqual(["id-1000"]);
  });

  it("partitions a large selection into ordered, disjoint batches covering every id", () => {
    const input = ids(2400);
    const batches = batchIds(input, 1000);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 400]);
    // Disjoint union in original order.
    expect(batches.flat()).toEqual(input);
    expect(new Set(batches.flat()).size).toBe(input.length);
  });

  it("defaults the size to MAX_QUERY_ACTION_ITEMS", () => {
    const batches = batchIds(ids(MAX_QUERY_ACTION_ITEMS + 1));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_QUERY_ACTION_ITEMS);
    expect(batches[1]).toHaveLength(1);
  });

  it("rejects a non-positive or non-integer batch size", () => {
    expect(() => batchIds(ids(5), 0)).toThrow();
    expect(() => batchIds(ids(5), -1)).toThrow();
    expect(() => batchIds(ids(5), 1.5)).toThrow();
  });
});
