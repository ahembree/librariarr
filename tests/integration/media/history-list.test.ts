import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Disable in-memory cache so each test gets fresh DB results
vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
});

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/history/route";

type HistoryResponse = {
  items: Array<{ mediaItem: { title: string; parentTitle: string | null } }>;
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
};

describe("GET /api/media/history", () => {
  let userId: string;
  let serverId: string;
  let libraryId: string;

  async function addWatch(mediaItemId: string) {
    await getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: serverId,
        serverUsername: "alice",
        watchedAt: new Date("2024-06-01T00:00:00Z"),
      },
    });
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRoute(GET, { url: "/api/media/history" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("answers an absurd page with an empty page, not a 500", async () => {
    // Live: `page=99999999999999999999` was a 500 (`ValueOutOfRange` from the
    // raw `OFFSET`) where a page past the end is just empty.
    const item = await createTestMediaItem(libraryId, { title: "Pilot", type: "SERIES" });
    await addWatch(item.id);
    const body = await expectJson<{ items: unknown[]; pagination: { hasMore: boolean; totalCount: number } }>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { page: "99999999999999999999" } }),
      200,
    );
    expect(body.items).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.totalCount).toBe(1);
  });

  it("rejects an unknown type with 400 instead of failing the query", async () => {
    for (const type of ["BOOK", "MOVIE|BOOK", "movie"]) {
      const body = await expectJson<{ error: string }>(
        await callRoute(GET, { url: "/api/media/history", searchParams: { type } }),
        400,
      );
      expect(body.error).toMatch(/Invalid type/);
    }
  });

  it("filters by one or several types", async () => {
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await addWatch(episode.id);

    const series = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { type: "SERIES" } }),
    );
    expect(series.items).toHaveLength(1);
    const either = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { type: "MOVIE|SERIES" } }),
    );
    expect(either.items).toHaveLength(1);
    const movies = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { type: "MOVIE" } }),
    );
    expect(movies.items).toHaveLength(0);
  });

  it("matches the episode title", async () => {
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Memories of Boom Boom Mountain",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 10,
    });
    await addWatch(episode.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "Boom Boom" },
      }),
    );

    expect(data.items).toHaveLength(1);
    expect(data.items[0].mediaItem.title).toBe(
      "Memories of Boom Boom Mountain",
    );
  });

  it("matches the series name via parentTitle", async () => {
    const ep1 = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Slumber Party Panic",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const ep2 = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Trouble in Lumpy Space",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    // An unrelated episode that should not match.
    const other = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "Regular Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await addWatch(ep1.id);
    await addWatch(ep2.id);
    await addWatch(other.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "adventure time" },
      }),
    );

    expect(data.items).toHaveLength(2);
    expect(
      data.items.every((i) => i.mediaItem.parentTitle === "Adventure Time"),
    ).toBe(true);
  });

  it("returns no rows for a non-matching search", async () => {
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Slumber Party Panic",
      parentTitle: "Adventure Time",
    });
    await addWatch(episode.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "Breaking Bad" },
      }),
    );

    expect(data.items).toHaveLength(0);
  });

  it("treats LIKE metacharacters in search literally", async () => {
    // Live (public API review): `?search=%` returned every play — the raw
    // ILIKE spliced the value into its pattern unescaped — and a `%_%_%_…`
    // pattern cost ~10× the CPU of a plain search.
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Slumber Party Panic",
      parentTitle: "Adventure Time",
    });
    await addWatch(episode.id);
    const oddOne = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "100% Wolf",
      parentTitle: "Odd_Title",
    });
    await addWatch(oddOne.id);

    // `%` on its own is a literal percent sign now, so it matches exactly the
    // one title that contains one — not every play.
    const lonePercent = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { search: "%" } }),
    );
    expect(lonePercent.items.map((i) => i.mediaItem.title)).toEqual(["100% Wolf"]);

    for (const search of ["%_%_%_%_%", "Slumber_Party"]) {
      const data = await expectJson<HistoryResponse>(
        await callRoute(GET, { url: "/api/media/history", searchParams: { search } }),
      );
      expect(data.items, `search=${search}`).toHaveLength(0);
      expect(data.pagination.totalCount, `search=${search}`).toBe(0);
    }

    const percent = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { search: "100%" } }),
    );
    expect(percent.items.map((i) => i.mediaItem.title)).toEqual(["100% Wolf"]);

    const underscore = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { search: "odd_" } }),
    );
    expect(underscore.items.map((i) => i.mediaItem.parentTitle)).toEqual(["Odd_Title"]);
  });

  it("counts with the same filters the page applies, including item-side ones", async () => {
    const lib2 = await createTestLibrary(serverId, { type: "MOVIE" });
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "Some Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const movie = await createTestMediaItem(lib2.id, { type: "MOVIE", title: "Some Film" });
    await addWatch(episode.id);
    await addWatch(movie.id);
    await addWatch(movie.id);

    const all = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history" }),
    );
    expect(all.pagination.totalCount).toBe(3);

    // `type` and `search` read MediaItem columns, so the count must join it.
    const series = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { type: "SERIES" } }),
    );
    expect(series.items).toHaveLength(1);
    expect(series.pagination.totalCount).toBe(1);

    const film = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { search: "Film" } }),
    );
    expect(film.items).toHaveLength(2);
    expect(film.pagination.totalCount).toBe(2);

    // A play-side filter alone must not need the join.
    const alice = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { username: "alice" } }),
    );
    expect(alice.pagination.totalCount).toBe(3);
  });
});
