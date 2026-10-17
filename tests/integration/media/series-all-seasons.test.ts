import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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
  return {
    // A constructor mock needs `function`: Vitest 4 cannot `new` an arrow.
    MemoryCache: vi.fn(function () {
      return noopCache;
    }),
    appCache: noopCache,
  };
});

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/series/all-seasons/route";

/**
 * Rows of a raw statement with no top-level ORDER BY come back reversed. SQL
 * promises no order there; that today's plan happens to emit GROUP BY output
 * in key order is exactly what a pageable route must not lean on.
 */
function reverseUnorderedRawRows() {
  const prisma = getTestPrisma();
  const original = prisma.$queryRawUnsafe.bind(prisma);
  return vi.spyOn(prisma, "$queryRawUnsafe").mockImplementation((async (sql: string, ...values: unknown[]) => {
    const rows: unknown = await original(sql, ...values);
    let topLevel = sql;
    for (let prev = ""; prev !== topLevel; ) {
      prev = topLevel;
      topLevel = topLevel.replace(/\([^()]*\)/g, "");
    }
    return /\bORDER BY\b/i.test(topLevel) || !Array.isArray(rows) ? rows : [...rows].reverse();
  }) as unknown as typeof prisma.$queryRawUnsafe);
}

describe("GET /api/media/series/all-seasons", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty seasons when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{ seasons: unknown[] }>(response, 200);
    expect(body.seasons).toEqual([]);
  });

  it("groups episodes by show and season", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 1,
      resolution: "1080p",
      fileSize: BigInt("500000000"),
      playCount: 3,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 2,
      resolution: "1080p",
      fileSize: BigInt("600000000"),
      playCount: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep1 S2",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 2,
      episodeNumber: 1,
      resolution: "4k",
      fileSize: BigInt("2000000000"),
      playCount: 0,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{
      seasons: {
        parentTitle: string;
        seasonNumber: number;
        episodeCount: number;
        totalSize: string;
        totalPlayCount: number;
        qualityCounts: Record<string, number>;
      }[];
    }>(response, 200);

    // Default sort is by parentTitle then seasonNumber
    expect(body.seasons.map((s) => [s.parentTitle, s.seasonNumber])).toEqual([
      ["Show A", 1],
      ["Show A", 2],
    ]);
    const [s1, s2] = body.seasons;
    expect(s1.episodeCount).toBe(2);
    expect(s1.totalSize).toBe("1100000000");
    expect(s1.totalPlayCount).toBe(4);
    expect(s1.qualityCounts).toEqual({ "1080P": 2 });

    expect(s2.episodeCount).toBe(1);
    expect(s2.totalSize).toBe("2000000000");
    expect(s2.totalPlayCount).toBe(0);
    expect(s2.qualityCounts).toEqual({ "4K": 1 });
  });

  it("filters by search query on parentTitle", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Better Call Saul",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
      searchParams: { search: "Breaking" },
    });
    const body = await expectJson<{
      seasons: { parentTitle: string }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0].parentTitle).toBe("Breaking Bad");
  });

  it("sorts by episodeCount descending", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Show A S1: 1 episode
    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    // Show B S1: 3 episodes
    for (let i = 1; i <= 3; i++) {
      await createTestMediaItem(lib.id, {
        title: `Ep${i}`,
        type: "SERIES",
        parentTitle: "Show B",
        seasonNumber: 1,
        episodeNumber: i,
        ratingKey: `b-s1e${i}`,
      });
    }

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
      searchParams: { sortBy: "episodeCount", sortOrder: "desc" },
    });
    const body = await expectJson<{
      seasons: { parentTitle: string; episodeCount: number }[];
    }>(response, 200);

    expect(body.seasons.map((s) => [s.parentTitle, s.episodeCount])).toEqual([
      ["Show B", 3],
      ["Show A", 1],
    ]);
  });

  it("tracks quality counts per resolution", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
      resolution: "1080p",
    });
    await createTestMediaItem(lib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 2,
      resolution: "4k",
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{
      seasons: { qualityCounts: Record<string, number> }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    // normalizeResolutionLabel maps these to display labels
    expect(body.seasons[0].qualityCounts).toEqual({ "1080P": 1, "4K": 1 });
  });

  it("serializes totalSize as string", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
      fileSize: BigInt("10737418240"),
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{
      seasons: { totalSize: string }[];
    }>(response, 200);

    expect(typeof body.seasons[0].totalSize).toBe("string");
    expect(body.seasons[0].totalSize).toBe("10737418240");
  });

  it("keeps two same-titled shows' seasons separate via seriesKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Both shows have a "season 1", but they are different shows.
    await createTestMediaItem(lib.id, {
      title: "Downsize", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Pilot", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 1,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{
      seasons: { parentTitle: string; seriesKey: string | null; seasonNumber: number }[];
    }>(await callRoute(GET, { url: "/api/media/series/all-seasons" }), 200);

    // Two season-1 rows — one per show — not one merged row.
    expect(body.seasons).toHaveLength(2);
    expect(body.seasons.every((x) => x.parentTitle === "The Office" && x.seasonNumber === 1)).toBe(true);
    expect(body.seasons.map((x) => x.seriesKey).sort()).toEqual(["tvdb:73244", "tvdb:78107"]);
  });

  // Seasons tying on the sort — two same-titled shows' Season 1 — came back in
  // whatever order the GROUP BY produced. The aggregate is ordered by
  // seriesKey + season and the sort is stable, so the tie order is fixed.
  it("orders seasons that tie on the sort by seriesKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    for (const key of ["tvdb:300", "tvdb:100", "tvdb:400", "tvdb:200"]) {
      for (const season of [2, 1]) {
        await createTestMediaItem(lib.id, {
          title: "Pilot", type: "SERIES", parentTitle: "The Office",
          seriesKey: key, seasonNumber: season, episodeNumber: 1,
        });
      }
    }
    setMockSession({ userId: user.id, isLoggedIn: true });

    const rows = async (searchParams: Record<string, string>) =>
      (await expectJson<{ seasons: { seriesKey: string; seasonNumber: number }[] }>(
        await callRoute(GET, { url: "/api/media/series/all-seasons", searchParams }),
        200,
      )).seasons.map((s) => `${s.seriesKey}/${s.seasonNumber}`);

    const spy = reverseUnorderedRawRows();
    try {
      // Title ties fall back to the season number, then to seriesKey.
      expect(await rows({})).toEqual([
        "tvdb:100/1", "tvdb:200/1", "tvdb:300/1", "tvdb:400/1",
        "tvdb:100/2", "tvdb:200/2", "tvdb:300/2", "tvdb:400/2",
      ]);
      // Every season ties on its episode count: seriesKey, then season.
      expect(await rows({ sortBy: "episodeCount", sortOrder: "desc" })).toEqual([
        "tvdb:100/1", "tvdb:100/2", "tvdb:200/1", "tvdb:200/2",
        "tvdb:300/1", "tvdb:300/2", "tvdb:400/1", "tvdb:400/2",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  // The All Seasons tab forwards every library filter; this route used to read
  // only the search, so resolution, genre, year … changed nothing on screen.
  describe("library filters", () => {
    async function seasons(query: string) {
      const body = await expectJson<{
        seasons: { parentTitle: string; seasonNumber: number; episodeCount: number }[];
      }>(await callRoute(GET, { url: `/api/media/series/all-seasons?${query}` }), 200);
      return body.seasons;
    }

    it("keeps a season with any matching episode, with its whole-season figures", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show A", seasonNumber: 1, episodeNumber: 1, resolution: "4k" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show A", seasonNumber: 1, episodeNumber: 2, resolution: "1080" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show A", seasonNumber: 2, episodeNumber: 1, resolution: "1080" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show B", seasonNumber: 1, episodeNumber: 1, resolution: "720" });
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Exactly what the page sends with the Resolution chip set to 4K.
      const result = await seasons("sortBy=parentTitle&sortOrder=asc&resolution=4K");
      expect(result.map((s) => [s.parentTitle, s.seasonNumber])).toEqual([["Show A", 1]]);
      expect(result[0].episodeCount).toBe(2);
    });

    it("answers a date filter with the season's own latest play", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      // Season 1: one episode last played in 2022, its finale in 2024.
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, lastPlayedAt: new Date("2022-03-01") });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2, lastPlayedAt: new Date("2024-03-01") });
      // Season 2: last played in 2022 only.
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 2, episodeNumber: 1, lastPlayedAt: new Date("2022-06-01") });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const result = await seasons("lastPlayedAtMax=2023-01-01");
      expect(result.map((s) => s.seasonNumber)).toEqual([2]);
    });

    // A season stored as "576" is a 480P chip, and must be found under 480P.
    it("matches a resolution by the label its quality chip shows", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "PAL Show", seasonNumber: 1, episodeNumber: 1, resolution: "576" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "HD Show", seasonNumber: 1, episodeNumber: 1, resolution: "1080" });
      // Not analysed yet: its season's chip counts it as Other.
      const raw = await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Raw Show", seasonNumber: 1, episodeNumber: 1 });
      await getTestPrisma().mediaItem.update({ where: { id: raw.id }, data: { resolution: null } });
      setMockSession({ userId: user.id, isLoggedIn: true });

      expect((await seasons("resolution=480P")).map((s) => s.parentTitle)).toEqual(["PAL Show"]);
      expect((await seasons("resolution=Other")).map((s) => s.parentTitle)).toEqual(["Raw Show"]);
    });

    // The season's own latest play answers the date filter; it must not also be
    // ANDed into the episode match, or beside another filter it demands ONE
    // episode that is both 4K and recently played.
    it("answers a date filter beside an episode filter with the season's own figures", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      // Season 1: its 4K episode played in 2022, its 1080p finale in 2024.
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, resolution: "4k", lastPlayedAt: new Date("2022-03-01") });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2, resolution: "1080", lastPlayedAt: new Date("2024-03-01") });
      // Season 2: an unplayed 4K episode, the rest last played in 2022.
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 2, episodeNumber: 1, resolution: "4k" });
      await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 2, episodeNumber: 2, resolution: "1080", lastPlayedAt: new Date("2022-06-01") });
      setMockSession({ userId: user.id, isLoggedIn: true });

      expect((await seasons("resolution=4K&lastPlayedAtMin=2024-01-01")).map((s) => s.seasonNumber)).toEqual([1]);
      expect((await seasons("resolution=4K&lastPlayedAtMax=2023-01-01")).map((s) => s.seasonNumber)).toEqual([2]);
    });
  });
});
