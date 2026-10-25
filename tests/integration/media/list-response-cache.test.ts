import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as moviesGet } from "@/app/api/media/movies/route";
import { GET as seriesGroupedGet } from "@/app/api/media/series/grouped/route";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import {
  listCacheKey,
  withListResponseCache,
  LIST_RESPONSE_CACHE_MAX_ENTRIES,
} from "@/lib/api/cached-list-response";
import { NextRequest, NextResponse } from "next/server";

type MoviesBody = { items: { id: string; title: string }[] };

async function seedMovies(titles: string[]) {
  const user = await createTestUser();
  setMockSession({ userId: user.id, isLoggedIn: true });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  for (const [i, title] of titles.entries()) {
    await createTestMediaItem(library.id, { title, type: "MOVIE", ratingKey: `rk${i}` });
  }
  return { user, server, library };
}

describe("library listing response cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("answers a repeated listing from the cache until media caches are invalidated", async () => {
    const { library } = await seedMovies(["Alpha"]);
    const first = await expectJson<MoviesBody>(await callRoute(moviesGet, { url: "/api/media/movies?limit=0" }), 200);
    expect(first.items.map((i) => i.title)).toEqual(["Alpha"]);

    // Written past the app, as nothing in it would: the cached answer stands.
    await createTestMediaItem(library.id, { title: "Beta", type: "MOVIE", ratingKey: "rk-b" });
    const cached = await expectJson<MoviesBody>(await callRoute(moviesGet, { url: "/api/media/movies?limit=0" }), 200);
    expect(cached.items.map((i) => i.title)).toEqual(["Alpha"]);

    // Every media write in the app ends here, and it drops the listing.
    invalidateMediaCaches();
    const fresh = await expectJson<MoviesBody>(await callRoute(moviesGet, { url: "/api/media/movies?limit=0" }), 200);
    expect(fresh.items.map((i) => i.title)).toEqual(["Alpha", "Beta"]);
  });

  it("keys on the query, whatever order its parameters come in", async () => {
    const { library } = await seedMovies(["Alpha"]);
    await callRoute(moviesGet, { url: "/api/media/movies?sortBy=title&limit=0" });
    await createTestMediaItem(library.id, { title: "Beta", type: "MOVIE", ratingKey: "rk-b" });

    const reordered = await expectJson<MoviesBody>(
      await callRoute(moviesGet, { url: "/api/media/movies?limit=0&sortBy=title" }),
      200,
    );
    expect(reordered.items).toHaveLength(1);

    const other = await expectJson<MoviesBody>(
      await callRoute(moviesGet, { url: "/api/media/movies?sortBy=year&limit=0" }),
      200,
    );
    expect(other.items).toHaveLength(2);
  });

  it("serves the stored gzip body to a gzip caller and plain JSON to the rest", async () => {
    await seedMovies(Array.from({ length: 60 }, (_, i) => `Movie ${String(i).padStart(2, "0")} with a long enough title`));
    const gz = await callRoute(moviesGet, { url: "/api/media/movies?limit=0", headers: { "Accept-Encoding": "gzip" } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const zipped = Buffer.from(await gz.arrayBuffer());
    expect(gz.headers.get("content-length")).toBe(String(zipped.byteLength));
    const fromGzip = JSON.parse(gunzipSync(zipped).toString()) as MoviesBody;
    expect(fromGzip.items).toHaveLength(60);

    const plain = await callRoute(moviesGet, { url: "/api/media/movies?limit=0" });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("content-type")).toBe("application/json");
    expect(plain.headers.get("vary")).toContain("Accept-Encoding");
    expect(((await plain.json()) as MoviesBody).items).toEqual(fromGzip.items);
  });

  it("never caches for a caller that is not signed in", async () => {
    const response = await callRoute(moviesGet, { url: "/api/media/movies" });
    expect(response.status).toBe(401);
    expect(appCache.get(listCacheKey("media-movies", "http://localhost/api/media/movies"))).toBeUndefined();
  });

  it("covers the grouped listings too", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(library.id, { title: "Pilot", parentTitle: "Show A", type: "SERIES", seasonNumber: 1, episodeNumber: 1, ratingKey: "e1" });
    type Grouped = { series: { title: string }[] };
    const first = await expectJson<Grouped>(await callRoute(seriesGroupedGet, { url: "/api/media/series/grouped?limit=0" }), 200);
    expect(first.series).toHaveLength(1);
    await createTestMediaItem(library.id, { title: "Pilot", parentTitle: "Show B", type: "SERIES", seasonNumber: 1, episodeNumber: 1, ratingKey: "e2" });
    const cached = await expectJson<Grouped>(await callRoute(seriesGroupedGet, { url: "/api/media/series/grouped?limit=0" }), 200);
    expect(cached.series).toHaveLength(1);
    invalidateMediaCaches();
    const fresh = await expectJson<Grouped>(await callRoute(seriesGroupedGet, { url: "/api/media/series/grouped?limit=0" }), 200);
    expect(fresh.series).toHaveLength(2);
  });

  describe("withListResponseCache", () => {
    it("passes an error through without keeping it", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      let calls = 0;
      const handler = withListResponseCache("test-error", async () => {
        calls++;
        return NextResponse.json({ error: "boom" }, { status: 500 });
      });
      const a = await handler(new NextRequest("http://localhost/api/x"));
      expect(a.status).toBe(500);
      expect(await a.json()).toEqual({ error: "boom" });
      await handler(new NextRequest("http://localhost/api/x"));
      expect(calls).toBe(2);
    });

    it("shares one run between concurrent identical requests", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      let calls = 0;
      const handler = withListResponseCache("test-shared", async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return NextResponse.json({ n: calls });
      });
      const [a, b] = await Promise.all([
        handler(new NextRequest("http://localhost/api/x")),
        handler(new NextRequest("http://localhost/api/x")),
      ]);
      expect(calls).toBe(1);
      expect(await a.json()).toEqual({ n: 1 });
      expect(await b.json()).toEqual({ n: 1 });
    });

    it("keeps at most its bound of listings, dropping the oldest", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const handler = withListResponseCache("test-bound", async (request) =>
        NextResponse.json({ url: request.url }),
      );
      for (let i = 0; i <= LIST_RESPONSE_CACHE_MAX_ENTRIES; i++) {
        await handler(new NextRequest(`http://localhost/api/x?i=${i}`));
      }
      expect(appCache.get(listCacheKey("test-bound", "http://localhost/api/x?i=0"))).toBeUndefined();
      expect(appCache.get(listCacheKey("test-bound", "http://localhost/api/x?i=1"))).toBeDefined();
      expect(
        appCache.get(listCacheKey("test-bound", `http://localhost/api/x?i=${LIST_RESPONSE_CACHE_MAX_ENTRIES}`)),
      ).toBeDefined();
    });

    it("never abandons a listing recomputing under a key an invalidation already emptied", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      let release!: () => void;
      let slowCalls = 0;
      let slow0 = false;
      const handler = withListResponseCache("test-prune", async (request) => {
        if (slow0 && new URL(request.url).searchParams.get("i") === "0") {
          slowCalls++;
          await new Promise<void>((r) => { release = r; });
        }
        return NextResponse.json({ url: request.url });
      });
      // Fill the bound, then drop every entry as a sync would.
      for (let i = 0; i < LIST_RESPONSE_CACHE_MAX_ENTRIES; i++) {
        await handler(new NextRequest(`http://localhost/api/x?i=${i}`));
      }
      invalidateMediaCaches();
      slow0 = true;
      // Listing 0, the oldest key, recomputes while another listing is stored.
      const slow = handler(new NextRequest("http://localhost/api/x?i=0"));
      await vi.waitFor(() => expect(slowCalls).toBe(1));
      await handler(new NextRequest("http://localhost/api/x?i=new"));
      release();
      await slow;
      expect(appCache.get(listCacheKey("test-prune", "http://localhost/api/x?i=0"))).toBeDefined();
      // Stored: the next visit is answered without running the handler.
      await handler(new NextRequest("http://localhost/api/x?i=0"));
      expect(slowCalls).toBe(1);
    });

    it("names its keys under the prefix invalidateMediaCaches drops", () => {
      expect(listCacheKey("media-movies", "http://localhost/api/media/movies?b=2&a=1")).toBe(
        `${LIST_RESPONSE_CACHE_PREFIX}media-movies?a=1&b=2`,
      );
    });
  });

  it("starts every test without the previous one's cached listings", async () => {
    // cleanDatabase drops cached listings, so a test never sees the last one's rows.
    await seedMovies(["Alpha"]);
    await callRoute(moviesGet, { url: "/api/media/movies?limit=0" });
    await cleanDatabase();
    const prisma = getTestPrisma();
    expect(await prisma.mediaItem.count()).toBe(0);
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const body = await expectJson<MoviesBody>(await callRoute(moviesGet, { url: "/api/media/movies?limit=0" }), 200);
    expect(body.items).toEqual([]);
  });
});
