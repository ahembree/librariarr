import { describe, it, expect, beforeEach, vi } from "vitest";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import { LIST_ROWS_MEMO_MAX_ENTRIES, listRowsKey, memoListRows } from "@/lib/api/list-rows-memo";

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
});
