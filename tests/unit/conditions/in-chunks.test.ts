import { describe, it, expect, vi } from "vitest";
import { IN_CHUNK_SIZE, findInChunks, inChunks } from "@/lib/conditions/in-chunks";

describe("inChunks", () => {
  it("slices a list into runs of at most the chunk size, keeping order", () => {
    expect(inChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inChunks([], 2)).toEqual([]);
  });

  it("keeps every slice well under Postgres' 32,767 bind parameters", () => {
    expect(IN_CHUNK_SIZE).toBeLessThan(32_767 / 2);
    const slices = inChunks(Array.from({ length: 40_000 }, (_, i) => i));
    expect(slices.map((s) => s.length)).toEqual([10_000, 10_000, 10_000, 10_000]);
  });
});

describe("findInChunks", () => {
  it("runs the query once per slice, in order, and concatenates the rows", async () => {
    const query = vi.fn(async (ids: number[]) => ids.map((id) => ({ id })));
    const rows = await findInChunks([1, 2, 3], query, 2);
    expect(query.mock.calls).toEqual([[[1, 2]], [[3]]]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("asks nothing for an empty list", async () => {
    const query = vi.fn(async () => [1]);
    expect(await findInChunks([], query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("collects more rows than a call takes arguments", async () => {
    const many = Array.from({ length: 200_000 }, (_, i) => i);
    const rows = await findInChunks([1], async () => many);
    expect(rows).toHaveLength(200_000);
  });
});
