import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const realtime = vi.hoisted(() => ({ live: true }));
vi.mock("@/hooks/use-realtime", () => ({ isRealtimeLive: () => realtime.live }));
import {
  clearLibraryListCache,
  createListCache,
  libraryListCache,
  listCacheKeyFor,
  loadCachedList,
  LIST_FRESH_MS,
  LIST_MAX_AGE_MS,
} from "@/lib/media/list-cache";

const fetchMock = vi.fn();

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearLibraryListCache();
  realtime.live = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createListCache", () => {
  it("reports an entry fresh, then stale, then gone", () => {
    let now = 0;
    const cache = createListCache({}, () => now);
    cache.set("k", [1]);
    expect(cache.get("k")).toEqual({ value: [1], fresh: true });
    now = LIST_FRESH_MS + 1;
    expect(cache.get("k")).toEqual({ value: [1], fresh: false });
    now = LIST_MAX_AGE_MS + 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("never reports an entry fresh while the events that clear it are not arriving", () => {
    let live = false;
    const cache = createListCache({ cleared: () => live });
    cache.set("k", [1]);
    expect(cache.get("k")).toEqual({ value: [1], fresh: false });
    live = true;
    expect(cache.get("k")).toEqual({ value: [1], fresh: true });
  });

  it("evicts the least recently used past its bound", () => {
    const cache = createListCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.value).toBe(1);
    expect(cache.get("c")?.value).toBe(3);
  });

  it("does not store what was read before a clear", () => {
    const cache = createListCache();
    const before = cache.generation();
    cache.clear();
    cache.set("a", "old", before);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "new", cache.generation());
    expect(cache.get("a")?.value).toBe("new");
    // Without a generation the value is stored as before.
    cache.set("b", 1);
    expect(cache.get("b")?.value).toBe(1);
  });

  it("clear empties it", () => {
    const cache = createListCache();
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("listCacheKeyFor", () => {
  it("does not split an entry on parameter order", () => {
    expect(listCacheKeyFor("/x", new URLSearchParams("b=2&a=1"))).toBe(listCacheKeyFor("/x", new URLSearchParams("a=1&b=2")));
    // Repeats keep their order: the handler reads the first.
    expect(listCacheKeyFor("/x", new URLSearchParams("a=2&a=1"))).toBe("/x?a=2&a=1");
    expect(listCacheKeyFor("/x", new URLSearchParams("a=1"))).not.toBe(listCacheKeyFor("/y", new URLSearchParams("a=1")));
  });
});

describe("loadCachedList", () => {
  it("fetches once, then answers from the cache while fresh", async () => {
    fetchMock.mockResolvedValue(respond({ series: [1, 2] }));
    const seen: unknown[] = [];
    await loadCachedList("/api/media/series/grouped", new URLSearchParams("limit=0"), (d) => seen.push(d));
    await loadCachedList("/api/media/series/grouped", new URLSearchParams("limit=0"), (d) => seen.push(d));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/media/series/grouped?limit=0");
    expect(seen).toEqual([{ series: [1, 2] }, { series: [1, 2] }]);

    // With pushes not arriving nothing would have cleared it: asked again.
    realtime.live = false;
    await loadCachedList("/api/media/series/grouped", new URLSearchParams("limit=0"), (d) => seen.push(d));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a stale entry at once, then the server's answer", async () => {
    let now = 0;
    const cache = createListCache({}, () => now);
    fetchMock.mockResolvedValueOnce(respond({ v: 1 }));
    await loadCachedList("/l", new URLSearchParams(), () => {}, cache);
    now = LIST_FRESH_MS + 1;
    fetchMock.mockResolvedValueOnce(respond({ v: 2 }));
    const seen: unknown[] = [];
    await loadCachedList("/l", new URLSearchParams(), (d) => seen.push(d), cache);
    expect(seen).toEqual([{ v: 1 }, { v: 2 }]);
    expect(cache.get("/l?")?.value).toEqual({ v: 2 });
  });

  it("rejects on an error status and keeps nothing", async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: "x" }, 500));
    await expect(loadCachedList("/l", new URLSearchParams(), () => {})).rejects.toThrow("HTTP 500");
    expect(libraryListCache.get("/l?")).toBeUndefined();
  });

  it("hands over but does not store an answer that crossed a clear", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const seen: unknown[] = [];
    const pending = loadCachedList("/l", new URLSearchParams(), (d) => seen.push(d));
    clearLibraryListCache();
    resolve(respond({ v: "pre-sync" }));
    await pending;
    expect(seen).toEqual([{ v: "pre-sync" }]);
    expect(libraryListCache.get("/l?")).toBeUndefined();
  });

  it("asks again once the cache is cleared", async () => {
    fetchMock.mockResolvedValue(respond({}));
    await loadCachedList("/l", new URLSearchParams(), () => {});
    clearLibraryListCache();
    await loadCachedList("/l", new URLSearchParams(), () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
