import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../../setup/test-db";
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

import { GET } from "@/app/api/v1/library/movies/route";
import { appCache } from "@/lib/cache/memory-cache";

interface V1Movie {
  id: string;
  title: string;
  year: number | null;
  type: string;
  resolution: string | null;
  fileSize: string | null;
  duration: number | null;
  playCount: number;
  library: { id: string; title: string };
  server: { id: string; name: string; type: string };
}

interface MovieList {
  items: V1Movie[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

const URL_MOVIES = "/api/v1/library/movies";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  // resolveServerFilter memoizes per user; a stale entry would outlive the row
  // it describes now that every test re-seeds from scratch.
  appCache.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedOwner() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id);
  const server = await createTestServer(user.id, { name: "Main" });
  const library = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
  return { user, raw, server, library };
}

describe("GET /api/v1/library/movies", () => {
  it("returns an empty list when the user has no servers", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns only MOVIE rows", async () => {
    const { raw, server, library } = await seedOwner();
    const tv = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
    await createTestMediaItem(library.id, { title: "The Matrix" });
    await createTestMediaItem(tv.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
    });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("The Matrix");
    expect(body.items[0].type).toBe("MOVIE");
  });

  it("serializes fileSize as a string and carries the library/server projection", async () => {
    const { raw, server, library } = await seedOwner();
    await createTestMediaItem(library.id, {
      title: "Dune",
      fileSize: BigInt("9007199254740993"),
    });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    const [movie] = body.items;
    expect(typeof movie.fileSize).toBe("string");
    // Larger than Number.MAX_SAFE_INTEGER — a number would have lost the value.
    expect(movie.fileSize).toBe("9007199254740993");
    expect(movie.library).toEqual({ id: library.id, title: "Movies" });
    expect(movie.server).toEqual({ id: server.id, name: "Main", type: "PLEX" });
  });

  it("returns null for a missing fileSize", async () => {
    const { raw, library } = await seedOwner();
    await getTestPrisma().mediaItem.create({
      data: { libraryId: library.id, ratingKey: "no-size", title: "Sizeless", type: "MOVIE" },
    });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items[0].fileSize).toBeNull();
  });

  it("omits the summary paragraph from list rows", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "Arrival", summary: "A long synopsis." });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items[0]).not.toHaveProperty("summary");
  });

  it("paginates with hasMore and honours page", async () => {
    const { raw, library } = await seedOwner();
    for (const title of ["A", "B", "C"]) {
      await createTestMediaItem(library.id, { title });
    }

    const first = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { limit: "2" } }),
    );
    expect(first.items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });

    const second = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { limit: "2", page: "2" } }),
    );
    expect(second.items.map((i) => i.title)).toEqual(["C"]);
    expect(second.pagination).toEqual({ page: 2, limit: 2, hasMore: false });
  });

  it("clamps limit to 200 and refuses 'return everything'", async () => {
    const { raw } = await seedOwner();

    const capped = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { limit: "5000" } }),
    );
    expect(capped.pagination.limit).toBe(200);

    // The internal routes read `limit=0` as "no bound"; v1 always paginates.
    const zero = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { limit: "0" } }),
    );
    expect(zero.pagination.limit).toBe(1);
  });

  it("falls back to the defaults for junk pagination values", async () => {
    const { raw } = await seedOwner();

    const body = await expectJson<MovieList>(
      await callV1(GET, {
        url: URL_MOVIES,
        key: raw,
        searchParams: { page: "abc", limit: "abc" },
      }),
    );
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("pages tied titles without duplicating or dropping rows", async () => {
    const { raw, library } = await seedOwner();
    for (let i = 0; i < 5; i++) {
      await createTestMediaItem(library.id, { title: "Same Title" });
    }

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await expectJson<MovieList>(
        await callV1(GET, {
          url: URL_MOVIES,
          key: raw,
          searchParams: { limit: "2", page: String(page) },
        }),
      );
      seen.push(...body.items.map((i) => i.id));
    }
    expect(new Set(seen).size).toBe(5);
  });

  it("filters by a case-insensitive title search", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "The Matrix" });
    await createTestMediaItem(library.id, { title: "Inception" });

    const body = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { search: "matrix" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["The Matrix"]);
  });

  it("filters by year and ignores a non-numeric year", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "Old", year: 1999 });
    await createTestMediaItem(library.id, { title: "New", year: 2024 });

    const filtered = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { year: "1999" } }),
    );
    expect(filtered.items.map((i) => i.title)).toEqual(["Old"]);

    const junk = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { year: "notayear" } }),
    );
    expect(junk.items).toHaveLength(2);
  });

  it("filters by the shared resolution vocabulary", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "UHD", resolution: "2160p" });
    await createTestMediaItem(library.id, { title: "HD", resolution: "1080p" });

    const body = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { resolution: "4K" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["UHD"]);

    const multi = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { resolution: "4K|1080P" } }),
    );
    expect(multi.items).toHaveLength(2);
  });

  it("sorts by an allowed column and direction", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "Old", year: 1999 });
    await createTestMediaItem(library.id, { title: "New", year: 2024 });

    const desc = await expectJson<MovieList>(
      await callV1(GET, {
        url: URL_MOVIES,
        key: raw,
        searchParams: { sortBy: "year", sortOrder: "desc" },
      }),
    );
    expect(desc.items.map((i) => i.year)).toEqual([2024, 1999]);
  });

  it("degrades an unknown sortBy to title instead of erroring", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "B" });
    await createTestMediaItem(library.id, { title: "A" });

    const body = await expectJson<MovieList>(
      await callV1(GET, {
        url: URL_MOVIES,
        key: raw,
        searchParams: { sortBy: "'; DROP TABLE", sortOrder: "sideways" },
      }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("narrows to one server and returns nothing for an unknown serverId", async () => {
    const { user, raw, library } = await seedOwner();
    const other = await createTestServer(user.id, { name: "Other" });
    const otherLib = await createTestLibrary(other.id, { title: "Films", type: "MOVIE" });
    await createTestMediaItem(library.id, { title: "On Main" });
    await createTestMediaItem(otherLib.id, { title: "On Other" });

    const narrowed = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { serverId: other.id } }),
    );
    expect(narrowed.items.map((i) => i.title)).toEqual(["On Other"]);

    const unknown = await expectJson<MovieList>(
      await callV1(GET, { url: URL_MOVIES, key: raw, searchParams: { serverId: "nope" } }),
    );
    expect(unknown.items).toEqual([]);
  });

  it("lists only the canonical copy once a second server holds movies", async () => {
    const { user, raw, library } = await seedOwner();
    const second = await createTestServer(user.id, { name: "Second" });
    const secondLib = await createTestLibrary(second.id, { title: "Films", type: "MOVIE" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        ratingKey: "canonical",
        title: "Heat",
        type: "MOVIE",
        dedupKey: "heat",
        dedupCanonical: true,
      },
    });
    await prisma.mediaItem.create({
      data: {
        libraryId: secondLib.id,
        ratingKey: "duplicate",
        title: "Heat",
        type: "MOVIE",
        dedupKey: "heat",
        dedupCanonical: false,
      },
    });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].server.name).toBe("Main");
  });

  it("never returns another user's movies", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "Mine" });

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "Movies", type: "MOVIE" });
    await createTestMediaItem(theirLib.id, { title: "Theirs" });

    const body = await expectJson<MovieList>(await callV1(GET, { url: URL_MOVIES, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual(["Mine"]);
  });

  it("cannot be pointed at another user's server", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, { title: "Mine" });

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "Movies", type: "MOVIE" });
    await createTestMediaItem(theirLib.id, { title: "Theirs" });

    const body = await expectJson<MovieList>(
      await callV1(GET, {
        url: URL_MOVIES,
        key: raw,
        searchParams: { serverId: theirServer.id },
      }),
    );
    expect(body.items).toEqual([]);
  });
});
