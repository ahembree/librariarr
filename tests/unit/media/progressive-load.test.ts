import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchListProgressively, FIRST_CHUNK_SIZE } from "@/lib/media/progressive-load";

const item = (id: number) => ({ id: `i${id}` });

/** Queue of responses, consumed in request order; records the URLs requested. */
function stubFetch(responses: Array<{ ok?: boolean; body?: unknown }>) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(url);
    const next = responses.shift() ?? { ok: true, body: { items: [] } };
    return { ok: next.ok ?? true, json: async () => next.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return urls;
}

describe("fetchListProgressively", () => {
  beforeEach(() => vi.clearAllMocks());
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

  it("falls back to a short page when the endpoint omits hasMore", async () => {
    const urls = stubFetch([{ body: { items: [item(1)] } }]);
    await fetchListProgressively("/api/media/movies", new URLSearchParams(), () => {});
    expect(urls).toHaveLength(1);
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
    stubFetch([{ ok: false, body: {} }]);
    const onChunk = vi.fn();
    await expect(
      fetchListProgressively("/api/media/movies", new URLSearchParams(), onChunk),
    ).rejects.toThrow();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("keeps the first chunk delivered when the second pass fails", async () => {
    const first = Array.from({ length: FIRST_CHUNK_SIZE }, (_, i) => item(i));
    stubFetch([
      { body: { items: first, pagination: { hasMore: true } } },
      { ok: false, body: {} },
    ]);

    const onChunk = vi.fn();
    await expect(
      fetchListProgressively("/api/media/movies", new URLSearchParams(), onChunk),
    ).rejects.toThrow();
    // The user still has a usable list rather than an empty page.
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][1]).toBe(false);
  });
});
