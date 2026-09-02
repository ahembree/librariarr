import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../../setup/test-db";
import { clearMockSession } from "../../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../../setup/test-helpers";
import { callV1 } from "../v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/library/search/route";
import { appCache } from "@/lib/cache/memory-cache";

interface V1Hit {
  id: string;
  title: string;
  type: string;
  year: number | null;
  parentTitle: string | null;
  albumTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  addedAt: string | null;
  library: { id: string; title: string };
  server: { id: string; name: string; type: string };
}

interface HitList {
  items: V1Hit[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

const URL_SEARCH = "/api/v1/library/search";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  appCache.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedLibrary() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id);
  const server = await createTestServer(user.id, { name: "Main" });
  const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
  const tv = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
  const music = await createTestLibrary(server.id, { title: "Music", type: "MUSIC" });

  await createTestMediaItem(movies.id, { title: "Blade Runner", year: 1982 });
  await createTestMediaItem(tv.id, {
    title: "Blade Episode",
    type: "SERIES",
    parentTitle: "Blade Show",
    seasonNumber: 1,
    episodeNumber: 1,
  });
  await createTestMediaItem(music.id, {
    title: "Blade Song",
    type: "MUSIC",
    parentTitle: "Blade Band",
    albumTitle: "Blade Album",
    episodeNumber: 1,
  });

  return { user, raw, server, movies, tv, music };
}

describe("GET /api/v1/library/search", () => {
  it("requires a query of at least two characters", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const expected = "q is required and must be at least 2 characters";

    for (const searchParams of [undefined, { q: "" }, { q: "a" }, { q: "  b  " }]) {
      const body = await expectJson<{ error: string }>(
        await callV1(GET, { url: URL_SEARCH, key: raw, searchParams }),
        400,
      );
      expect(body.error).toBe(expected);
    }
  });

  it("rejects an unknown type", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<{ error: string }>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade", type: "book" } }),
      400,
    );
    expect(body.error).toBe("type must be one of MOVIE, SERIES, MUSIC, EPISODE, TRACK");
  });

  it("searches across every media type when no type is given", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade" } }),
    );
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i) => i.type).sort()).toEqual(["MOVIE", "MUSIC", "SERIES"]);
  });

  it("orders hits by title", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual([
      "Blade Episode",
      "Blade Runner",
      "Blade Song",
    ]);
  });

  it("resolves the EPISODE alias to stored SERIES rows", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, {
        url: URL_SEARCH,
        key: raw,
        searchParams: { q: "blade", type: "EPISODE" },
      }),
    );
    expect(body.items).toHaveLength(1);
    // The alias is input-only: the payload always carries the real LibraryType.
    expect(body.items[0].type).toBe("SERIES");
    expect(body.items[0].parentTitle).toBe("Blade Show");
  });

  it("resolves the TRACK alias to stored MUSIC rows", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade", type: "TRACK" } }),
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe("MUSIC");
    expect(body.items[0].albumTitle).toBe("Blade Album");
  });

  it("accepts a lower-cased type", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade", type: "movie" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["Blade Runner"]);
  });

  it("matches on show title and album title, not just the item title", async () => {
    const { raw } = await seedLibrary();

    const byShow = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade show" } }),
    );
    expect(byShow.items.map((i) => i.title)).toEqual(["Blade Episode"]);

    const byAlbum = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade album" } }),
    );
    expect(byAlbum.items.map((i) => i.title)).toEqual(["Blade Song"]);
  });

  it("matches case-insensitively", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "BLADE RUNNER" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["Blade Runner"]);
  });

  it("returns the library and server projection on every hit", async () => {
    const { raw, server, movies } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "runner" } }),
    );
    const [hit] = body.items;
    expect(hit.library).toEqual({ id: movies.id, title: "Movies" });
    expect(hit.server).toEqual({ id: server.id, name: "Main", type: "PLEX" });
    expect(hit.year).toBe(1982);
  });

  it("paginates and clamps limit to 200", async () => {
    const { raw } = await seedLibrary();

    const first = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade", limit: "2" } }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });

    const second = await expectJson<HitList>(
      await callV1(GET, {
        url: URL_SEARCH,
        key: raw,
        searchParams: { q: "blade", limit: "2", page: "2" },
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.pagination.hasMore).toBe(false);

    const capped = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade", limit: "500" } }),
    );
    expect(capped.pagination.limit).toBe(200);
  });

  it("returns nothing for an unknown serverId", async () => {
    const { raw } = await seedLibrary();

    const body = await expectJson<HitList>(
      await callV1(GET, {
        url: URL_SEARCH,
        key: raw,
        searchParams: { q: "blade", serverId: "nope" },
      }),
    );
    expect(body.items).toEqual([]);
  });

  it("never surfaces another user's media", async () => {
    const { raw } = await seedLibrary();

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "Movies", type: "MOVIE" });
    await createTestMediaItem(theirLib.id, { title: "Blade II" });

    const body = await expectJson<HitList>(
      await callV1(GET, { url: URL_SEARCH, key: raw, searchParams: { q: "blade" } }),
    );
    expect(body.items.map((i) => i.title)).not.toContain("Blade II");

    const pointed = await expectJson<HitList>(
      await callV1(GET, {
        url: URL_SEARCH,
        key: raw,
        searchParams: { q: "blade", serverId: theirServer.id },
      }),
    );
    expect(pointed.items).toEqual([]);
  });
});
