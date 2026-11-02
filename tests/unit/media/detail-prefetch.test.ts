import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPrefetchStore,
  detailChildrenUrl,
  detailPrefetch,
  dropMediaDerivedPrefetches,
  mediaPlaysUrl,
  prefetchMediaDetail,
  prefetchMediaRecord,
  PLAY_HISTORY_PAGE_SIZE,
} from "@/lib/media/detail-prefetch";

const fetchMock = vi.fn();

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  detailPrefetch.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPrefetchStore", () => {
  it("hands a prefetched answer over once, then goes to the network", async () => {
    fetchMock.mockResolvedValue(respond({ n: 1 }));
    const store = createPrefetchStore(30_000, 10);
    store.prefetch("/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await store.fetch("/a")).toEqual({ ok: true, status: 200, body: { n: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Taken: a refetch asks the server.
    fetchMock.mockResolvedValue(respond({ n: 2 }));
    expect((await store.fetch("/a")).body).toEqual({ n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a second request for a URL already prefetched", () => {
    fetchMock.mockResolvedValue(respond({}));
    const store = createPrefetchStore(30_000, 10);
    store.prefetch("/a");
    store.prefetch("/a");
    void store.peek("/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("peek keeps the entry for a later take", async () => {
    fetchMock.mockResolvedValue(respond({ summary: "s" }));
    const store = createPrefetchStore(30_000, 10);
    expect((await store.peek("/a")).body).toEqual({ summary: "s" });
    expect(store.take("/a")).not.toBeNull();
    expect(store.take("/a")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never serves an expired entry", async () => {
    let now = 1000;
    fetchMock.mockResolvedValue(respond({}));
    const store = createPrefetchStore(30_000, 10, () => now);
    store.prefetch("/a");
    now += 30_001;
    expect(store.take("/a")).toBeNull();
    await store.fetch("/a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops an error answer so the reader asks again", async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: "x" }, 500));
    const store = createPrefetchStore(30_000, 10);
    const first = await store.peek("/a");
    expect(first).toEqual({ ok: false, status: 500, body: { error: "x" } });
    expect(store.take("/a")).toBeNull();
  });

  it("reports a failed request as status 0 and keeps nothing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const store = createPrefetchStore(30_000, 10);
    expect(await store.peek("/a")).toEqual({ ok: false, status: 0, body: null });
    expect(store.take("/a")).toBeNull();
  });

  it("reads a body that is not JSON as null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } });
    const store = createPrefetchStore(30_000, 10);
    expect(await store.fetch("/a")).toEqual({ ok: true, status: 200, body: null });
  });

  it("forgets the oldest entry past its bound", () => {
    fetchMock.mockResolvedValue(respond({}));
    const store = createPrefetchStore(30_000, 2);
    store.prefetch("/a");
    store.prefetch("/b");
    store.prefetch("/c");
    expect(store.take("/a")).toBeNull();
    expect(store.take("/b")).not.toBeNull();
    expect(store.take("/c")).not.toBeNull();
  });

  it("clearWhere forgets only what it is asked to", () => {
    fetchMock.mockResolvedValue(respond({}));
    const store = createPrefetchStore(30_000, 10);
    store.prefetch("/a");
    store.prefetch("/b");
    store.clearWhere((url) => url === "/a");
    expect(store.take("/a")).toBeNull();
    expect(store.take("/b")).not.toBeNull();
  });

  it("clear forgets everything", () => {
    fetchMock.mockResolvedValue(respond({}));
    const store = createPrefetchStore(30_000, 10);
    store.prefetch("/a");
    store.clear();
    expect(store.take("/a")).toBeNull();
  });
});

describe("detail prefetches", () => {
  it("names the play history card's first page the way PlayHistory asks for it", () => {
    expect(mediaPlaysUrl("m1", 1)).toBe(`/api/media/m1/plays?page=1&limit=${PLAY_HISTORY_PAGE_SIZE}`);
    expect(mediaPlaysUrl("m1", 2, "s1")).toBe(`/api/media/m1/plays?page=2&limit=${PLAY_HISTORY_PAGE_SIZE}&serverId=s1`);
  });

  it("prefetchMediaRecord warms only the record", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaRecord("m1");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/media/m1"]);
  });

  it("prefetchMediaDetail starts every id-only request of a movie page together", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaDetail("m1", { mediaType: "MOVIE", plays: true });
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      ["/api/media/m1", "/api/media/m1/arr-info", "/api/media/m1/seerr-info", mediaPlaysUrl("m1", 1)].sort(),
    );
  });

  it("asks Seerr nothing for music, and no plays when the page scopes them otherwise", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaDetail("t1", { mediaType: "MUSIC", plays: false });
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(["/api/media/t1", "/api/media/t1/arr-info"]);
  });

  it("names each detail page's child list by the page's own id", () => {
    expect(detailChildrenUrl("seasons", "s 1")).toBe("/api/media/series/seasons?itemId=s%201");
    expect(detailChildrenUrl("episodes", "e1")).toBe("/api/media/series?itemId=e1&sortBy=episodeNumber&sortOrder=asc&limit=0");
    expect(detailChildrenUrl("tracks", "t1")).toBe("/api/media/music?itemId=t1&sortBy=episodeNumber&sortOrder=asc&limit=0");
    expect(detailChildrenUrl("albums", "a1")).toBe("/api/media/music/albums?itemId=a1");
  });

  it("starts the child list with the record, and no integrations when the page shows none", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaDetail("a1", { mediaType: "MUSIC", plays: false, integrations: false, children: "albums" });
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      ["/api/media/a1", detailChildrenUrl("albums", "a1")].sort(),
    );
    expect(detailPrefetch.take(detailChildrenUrl("albums", "a1"))).not.toBeNull();
  });

  it("drops a child list on a media change, like the record", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaDetail("s1", { mediaType: "SERIES", plays: false, children: "seasons" });
    dropMediaDerivedPrefetches();
    expect(detailPrefetch.take(detailChildrenUrl("seasons", "s1"))).toBeNull();
  });

  it("reuses a record the hover already warmed", async () => {
    fetchMock.mockResolvedValue(respond({ item: { id: "m1" } }));
    prefetchMediaRecord("m1");
    prefetchMediaDetail("m1", { mediaType: "MOVIE", plays: false });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/media/m1")).toHaveLength(1);
  });

  it("drops records and play pages on a media change but keeps the Arr/Seerr matches", () => {
    fetchMock.mockResolvedValue(respond({}));
    prefetchMediaDetail("m1", { mediaType: "MOVIE", plays: true });
    dropMediaDerivedPrefetches();
    expect(detailPrefetch.take("/api/media/m1")).toBeNull();
    expect(detailPrefetch.take(mediaPlaysUrl("m1", 1))).toBeNull();
    expect(detailPrefetch.take("/api/media/m1/arr-info")).not.toBeNull();
    expect(detailPrefetch.take("/api/media/m1/seerr-info")).not.toBeNull();
  });
});
