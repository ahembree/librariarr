import { describe, it, expect, beforeEach, vi } from "vitest";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import {
  LIST_ROWS_MEMO_MAX_BYTES,
  LIST_ROWS_MEMO_MAX_ENTRIES,
  LIST_ROWS_MEMO_MAX_TOTAL_BYTES,
  estimateRowsBytes,
  listRowsKey,
  memoListRows,
} from "@/lib/api/list-rows-memo";

beforeEach(() => {
  appCache.clear();
});

describe("memoListRows", () => {
  it("keys a listing without its page parameters, under the listing prefix", () => {
    const a = listRowsKey("x", new URLSearchParams("sortBy=title&limit=100&offset=200&index=1&page=3"));
    const b = listRowsKey("x", new URLSearchParams("offset=0&limit=50&sortBy=title"));
    expect(a).toBe(b);
    expect(a.startsWith(`${LIST_RESPONSE_CACHE_PREFIX}rows:x?`)).toBe(true);
    expect(listRowsKey("x", new URLSearchParams("sortBy=year"))).not.toBe(a);
  });

  it("computes a listing once for every page of it, and once for concurrent pages", async () => {
    const compute = vi.fn(async () => [1, 2, 3]);
    const [first, second] = await Promise.all([
      memoListRows("x", new URLSearchParams("limit=100&offset=0"), compute),
      memoListRows("x", new URLSearchParams("limit=100&offset=100"), compute),
    ]);
    await memoListRows("x", new URLSearchParams("limit=100&offset=200"), compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("is dropped by invalidateMediaCaches", async () => {
    const compute = vi.fn(async () => ["row"]);
    await memoListRows("x", new URLSearchParams(), compute);
    invalidateMediaCaches();
    await memoListRows("x", new URLSearchParams(), compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps a bounded number of listings, the oldest going first", async () => {
    for (let i = 0; i <= LIST_ROWS_MEMO_MAX_ENTRIES; i++) {
      await memoListRows("x", new URLSearchParams(`q=${i}`), async () => [i]);
    }
    expect(appCache.get(listRowsKey("x", new URLSearchParams("q=0")))).toBeUndefined();
    expect(appCache.get(listRowsKey("x", new URLSearchParams(`q=${LIST_ROWS_MEMO_MAX_ENTRIES}`)))).toEqual([
      LIST_ROWS_MEMO_MAX_ENTRIES,
    ]);
  });

  it("keeps nothing when the compute fails", async () => {
    await expect(memoListRows("x", new URLSearchParams(), async () => Promise.reject(new Error("db")))).rejects.toThrow("db");
    const compute = vi.fn(async () => [1]);
    await memoListRows("x", new URLSearchParams(), compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("estimates a value's size from a sample of the rows in it", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}` }));
    const exact = JSON.stringify(rows[0]).length * rows.length;
    expect(estimateRowsBytes(rows)).toBe(exact);
    // A memoised route's value: its array fields count, the rest do not.
    expect(estimateRowsBytes({ rows, keys: ["a", "b"], presenceAfterPaging: true })).toBe(exact + 6);
    expect(estimateRowsBytes([])).toBe(0);
    expect(estimateRowsBytes(null)).toBe(0);
    // A row JSON cannot hold still counts.
    expect(estimateRowsBytes([{ size: BigInt(1) }])).toBeGreaterThan(0);
  });

  it("answers a listing too large to keep without keeping it", async () => {
    const big = "x".repeat(1024);
    const rows = Array.from({ length: Math.ceil(LIST_ROWS_MEMO_MAX_BYTES / 1024) + 10 }, () => ({ big }));
    const compute = vi.fn(async () => rows);
    expect(await memoListRows("big", new URLSearchParams(), compute)).toBe(rows);
    await memoListRows("big", new URLSearchParams(), compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps the listings together under a byte bound, the oldest going first", async () => {
    const size = Math.floor(LIST_ROWS_MEMO_MAX_BYTES / 2);
    const rows = (tag: string) => Array.from({ length: 64 }, () => ({ v: tag.repeat(Math.floor(size / 64)) }));
    const count = Math.ceil(LIST_ROWS_MEMO_MAX_TOTAL_BYTES / size) + 1;
    expect(count).toBeLessThanOrEqual(LIST_ROWS_MEMO_MAX_ENTRIES);
    for (let i = 0; i < count; i++) {
      await memoListRows("sized", new URLSearchParams(`q=${i}`), async () => rows("a"));
    }
    expect(appCache.get(listRowsKey("sized", new URLSearchParams("q=0")))).toBeUndefined();
    expect(appCache.get(listRowsKey("sized", new URLSearchParams(`q=${count - 1}`)))).toBeDefined();
  });
});
