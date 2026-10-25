import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchListProgressively, FIRST_CHUNK_SIZE } from "@/lib/media/progressive-load";
import { clearLibraryListCache } from "@/lib/media/list-cache";

const item = (id: number) => ({ id: `i${id}` });

/** Queue of responses, consumed in request order; records the URLs requested. */
function stubFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(url);
    const next = responses.shift() ?? { body: { items: [] } };
    const status = next.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => next.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return urls;
}

describe("fetchListProgressively", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLibraryListCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("emits the first screenful before the rest", async () => {
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    stubFetch([
      { body: { items: first, pagination: { hasMore: true } } },
      { body: { items: [item(1000), item(1001)], pagination: { hasMore: false } } },
    ]);

    const chunks: Array<{ count: number; done: boolean }> = [];
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), (items, done) =>
      chunks.push({ count: items.length, done }),
    );

    expect(chunks).toEqual([
      { count: FIRST_CHUNK_SIZE, done: false },
      { count: FIRST_CHUNK_SIZE + 2, done: true },
    ]);
  });

  it("hands back the full accumulated list, not a delta", async () => {
    stubFetch([
      { body: { items: [item(1)], pagination: { hasMore: true } } },
      { body: { items: [item(2)], pagination: { hasMore: false } } },
    ]);

    const seen: string[][] = [];
    await fetchListProgressively<{ id: string }>(
      "/api/media/movies",
      new URLSearchParams(),
      (items) => seen.push(items.map((i) => i.id)),
    );

    expect(seen).toEqual([["i1"], ["i1", "i2"]]);
  });

  it("requests the first page bounded, then the remainder by offset", async () => {
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    const urls = stubFetch([
      { body: { items: first, pagination: { hasMore: true } } },
      { body: { items: [], pagination: { hasMore: false } } },
    ]);

    await fetchListProgressively(
      "/api/media/movies",
      new URLSearchParams({ sortBy: "title", resolution: "4K" }),
      () => {},
    );

    expect(urls).toHaveLength(2);
    const firstUrl = new URL(urls[0], "http://x");
    expect(firstUrl.searchParams.get("limit")).toBe(String(FIRST_CHUNK_SIZE));
    expect(firstUrl.searchParams.get("page")).toBe("1");

    const secondUrl = new URL(urls[1], "http://x");
    expect(secondUrl.searchParams.get("limit")).toBe("0");
    // Skips exactly what the first pass delivered — nothing transferred twice.
    expect(secondUrl.searchParams.get("offset")).toBe(String(FIRST_CHUNK_SIZE));
    // Filters and sort carry across both passes or the halves wouldn't line up.
    expect(secondUrl.searchParams.get("sortBy")).toBe("title");
    expect(secondUrl.searchParams.get("resolution")).toBe("4K");
  });

  it("ignores pagination params the caller spread in", async () => {
    // Pages spread user-controlled filters into these params; a stray offset
    // riding along would silently skip rows out of the very first pass.
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    const urls = stubFetch([
      { body: { items: first, pagination: { hasMore: true } } },
      { body: { items: [], pagination: { hasMore: false } } },
    ]);
    await fetchListProgressively(
      "/api/media/movies",
      new URLSearchParams({ limit: "0", offset: "999", page: "7" }),
      () => {},
    );

    const sent = new URL(urls[0], "http://x");
    expect(sent.searchParams.get("limit")).toBe(String(FIRST_CHUNK_SIZE));
    expect(sent.searchParams.get("offset")).toBeNull();
    expect(sent.searchParams.get("page")).toBe("1");

    const rest = new URL(urls[1], "http://x");
    expect(rest.searchParams.get("offset")).toBe(String(FIRST_CHUNK_SIZE));
    expect(rest.searchParams.get("page")).toBeNull();
  });

  it("makes only one request when the library fits in the first pass", async () => {
    const urls = stubFetch([
      { body: { items: [item(1), item(2)], pagination: { hasMore: false } } },
    ]);

    const chunks: boolean[] = [];
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), (_, done) =>
      chunks.push(done),
    );

    expect(urls).toHaveLength(1);
    expect(chunks).toEqual([true]);
  });

  it("falls back to the page length when the endpoint omits hasMore", async () => {
    // A short page is everything.
    const shortUrls = stubFetch([{ body: { items: [item(1)] } }]);
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), () => {});
    expect(shortUrls).toHaveLength(1);

    // A full page may have more behind it. (The list just loaded is cached.)
    clearLibraryListCache();
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    const fullUrls = stubFetch([{ body: { items: first } }, { body: { items: [item(1000)] } }]);
    const chunks: boolean[] = [];
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), (_, done) => chunks.push(done));
    expect(fullUrls).toHaveLength(2);
    expect(chunks).toEqual([false, true]);
  });

  it("treats an empty first pass as done", async () => {
    const urls = stubFetch([{ body: { items: [], pagination: { hasMore: false } } }]);
    const chunks: number[] = [];
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), (items) =>
      chunks.push(items.length),
    );
    expect(urls).toHaveLength(1);
    expect(chunks).toEqual([0]);
  });

  it("throws when the first pass fails, without emitting", async () => {
    stubFetch([{ status: 500, body: { error: "Failed to fetch movies" } }]);
    const onChunk = vi.fn();
    await expect(
      fetchListProgressively("/api/media/movies", new URLSearchParams(), onChunk),
    ).rejects.toThrow("HTTP 500");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("keeps the first chunk delivered when the second pass fails", async () => {
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    stubFetch([
      { body: { items: first, pagination: { hasMore: true } } },
      { status: 503, body: {} },
    ]);

    const onChunk = vi.fn();
    await expect(
      fetchListProgressively("/api/media/movies", new URLSearchParams(), onChunk),
    ).rejects.toThrow("HTTP 503");
    // The user still has a usable list rather than an empty page.
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(first, false);
  });

  it("does not store a list whose second pass crossed a clear", async () => {
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    let resolveRest!: (v: unknown) => void;
    const fn = vi.fn(async (url: string) => {
      if (url.includes("offset=")) {
        const body = await new Promise((r) => { resolveRest = r; });
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ items: first, pagination: { hasMore: true } }) } as Response;
    });
    vi.stubGlobal("fetch", fn);
    const pending = fetchListProgressively("/api/media/movies", new URLSearchParams(), () => {});
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    clearLibraryListCache();
    resolveRest({ items: [item(1000)] });
    await pending;
    const seen: boolean[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response));
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), (_, done) => seen.push(done));
    // Not served from the cache: the stale list was never stored.
    expect(seen).toEqual([true]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
