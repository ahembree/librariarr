import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const realtime = vi.hoisted(() => ({ live: true }));
vi.mock("@/hooks/use-realtime", () => ({ isRealtimeLive: () => realtime.live }));
import {
  clearLibraryListCache,
  createListCache,
  libraryListCache,
  fetchJson,
  listCacheKeyFor,
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
    expect(cache.get("k")).toEqual({ value: [1], fresh: true, storedAt: 0 });
    now = LIST_FRESH_MS + 1;
    expect(cache.get("k")).toEqual({ value: [1], fresh: false, storedAt: 0 });
    now = LIST_MAX_AGE_MS + 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("never reports an entry fresh while the events that clear it are not arriving", () => {
    let live = false;
    const cache = createListCache({ cleared: () => live });
    cache.set("k", [1]);
    expect(cache.get("k")).toMatchObject({ value: [1], fresh: false });
    live = true;
    expect(cache.get("k")).toMatchObject({ value: [1], fresh: true });
  });

  it("keeps the age it is given, so storing a listing again does not make it younger", () => {
    let now = 0;
    const cache = createListCache({}, () => now);
    cache.set("k", "first page");
    now = LIST_FRESH_MS + 10;
    // A later page of the same listing, stored with the time its index was read.
    cache.set("k", "two pages", undefined, 0);
    expect(cache.get("k")).toEqual({ value: "two pages", fresh: false, storedAt: 0 });
    now = LIST_MAX_AGE_MS + 1;
    cache.set("k", "three pages", undefined, 0);
    expect(cache.get("k")).toBeUndefined();
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

describe("fetchJson", () => {
  it("answers the body, and rejects on an error status", async () => {
    fetchMock.mockResolvedValueOnce(respond({ items: [1] }));
    await expect(fetchJson("/api/media/movies?limit=100&offset=0")).resolves.toEqual({ items: [1] });
    expect(fetchMock).toHaveBeenCalledWith("/api/media/movies?limit=100&offset=0");

    fetchMock.mockResolvedValueOnce(respond({ error: "boom" }, 500));
    await expect(fetchJson("/l")).rejects.toThrow("HTTP 500");
  });

  it("passes an abort signal through", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(respond({}));
    await fetchJson("/l", controller.signal);
    expect(fetchMock).toHaveBeenCalledWith("/l", { signal: controller.signal });
  });

  it("is what the library list cache keys its pages' listings with", () => {
    libraryListCache.set("k", 1);
    expect(libraryListCache.get("k")?.value).toBe(1);
  });
});
