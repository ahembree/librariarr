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
import { GET } from "@/app/api/media/series/grouped/route";

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

describe("GET /api/media/series/grouped", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ─── Auth ───

  describe("authentication", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });
  });

  // ─── Empty state ───

  describe("empty state", () => {
    it("returns empty series with no data, includes pagination", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: unknown[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.series).toEqual([]);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  // ─── Grouping ───

  describe("grouping", () => {
    it("groups episodes by show with correct counts", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Breaking Bad: 3 episodes across 2 seasons
      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 1,
        resolution: "1080p",
        fileSize: BigInt("1073741824"),
      });
      await createTestMediaItem(lib.id, {
        title: "Cat's in the Bag",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 2,
        resolution: "1080p",
        fileSize: BigInt("1073741824"),
      });
      await createTestMediaItem(lib.id, {
        title: "Face Off",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 4,
        episodeNumber: 13,
        resolution: "4k",
        fileSize: BigInt("4294967296"),
      });

      // The Wire: 1 episode
      await createTestMediaItem(lib.id, {
        title: "The Target",
        type: "SERIES",
        parentTitle: "The Wire",
        seasonNumber: 1,
        episodeNumber: 1,
        resolution: "720p",
        fileSize: BigInt("536870912"),
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: {
          parentTitle: string;
          episodeCount: number;
          seasonCount: number;
          totalSize: string;
          qualityCounts: Record<string, number>;
        }[];
      }>(response, 200);

      expect(body.series.map((s) => s.parentTitle)).toEqual(["Breaking Bad", "The Wire"]);
      const [bb, wire] = body.series;

      expect(bb.episodeCount).toBe(3);
      expect(bb.seasonCount).toBe(2);
      // 1GB + 1GB + 4GB = 6GB = 6442450944 bytes
      expect(bb.totalSize).toBe("6442450944");
      expect(bb.qualityCounts).toEqual({ "1080P": 2, "4K": 1 });

      expect(wire.episodeCount).toBe(1);
      expect(wire.seasonCount).toBe(1);
      expect(wire.totalSize).toBe("536870912");
      expect(wire.qualityCounts).toEqual({ "720P": 1 });
    });

    it("does not include MOVIE or MUSIC items in series grouping", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });
      const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
      const musicLib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(seriesLib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(movieLib.id, {
        title: "The Matrix",
        type: "MOVIE",
      });
      await createTestMediaItem(musicLib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].parentTitle).toBe("Arrow");
    });

    it("serializes totalSize as string (BigInt)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "BigShow",
        seasonNumber: 1,
        fileSize: BigInt("10737418240"),
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { totalSize: string }[];
      }>(response, 200);

      expect(body.series[0].totalSize).toBe("10737418240");
      expect(typeof body.series[0].totalSize).toBe("string");
    });
  });

  // ─── Pagination ───

  describe("pagination", () => {
    it("paginates grouped series correctly", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Create 5 different series with one episode each
      const seriesNames = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
      for (const name of seriesNames) {
        await createTestMediaItem(lib.id, {
          title: "S01E01",
          type: "SERIES",
          parentTitle: name,
          seasonNumber: 1,
          episodeNumber: 1,
          ratingKey: `rk-${name}`,
        });
      }

      setMockSession({ userId: user.id, isLoggedIn: true });

      // Page 1, limit 2
      const response1 = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { page: "1", limit: "2" },
      });
      const body1 = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response1, 200);

      expect(body1.series.map((s) => s.parentTitle)).toEqual(["Alpha", "Bravo"]);
      expect(body1.pagination.page).toBe(1);
      expect(body1.pagination.limit).toBe(2);
      expect(body1.pagination.hasMore).toBe(true);

      // Page 2, limit 2
      const response2 = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { page: "2", limit: "2" },
      });
      const body2 = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response2, 200);

      expect(body2.series.map((s) => s.parentTitle)).toEqual(["Charlie", "Delta"]);
      expect(body2.pagination.page).toBe(2);
      expect(body2.pagination.hasMore).toBe(true);

      // Page 3, limit 2 (last page)
      const response3 = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { page: "3", limit: "2" },
      });
      const body3 = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response3, 200);

      expect(body3.series.map((s) => s.parentTitle)).toEqual(["Echo"]);
      expect(body3.pagination.hasMore).toBe(false);
    });

    it("honours offset, which overrides page, as the shared paging contract documents", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
        await createTestMediaItem(lib.id, {
          title: "S01E01",
          type: "SERIES",
          parentTitle: name,
          seasonNumber: 1,
          episodeNumber: 1,
          ratingKey: `rk-${name}`,
        });
      }
      setMockSession({ userId: user.id, isLoggedIn: true });

      const titles = async (searchParams: Record<string, string>) => {
        const body = await expectJson<{ series: { parentTitle: string }[]; pagination: { hasMore: boolean } }>(
          await callRoute(GET, { url: "/api/media/series/grouped", searchParams }),
          200,
        );
        return { titles: body.series.map((s) => s.parentTitle), hasMore: body.pagination.hasMore };
      };

      // Before the fix every one of these answered page 1 ("Alpha", "Bravo").
      expect(await titles({ limit: "2", offset: "2" })).toEqual({ titles: ["Charlie", "Delta"], hasMore: true });
      expect(await titles({ limit: "2", offset: "4" })).toEqual({ titles: ["Echo"], hasMore: false });
      expect(await titles({ page: "1", limit: "2", offset: "1" })).toEqual({ titles: ["Bravo", "Charlie"], hasMore: true });
      // limit=0 with an offset is "everything after the first N", as on the flat lists.
      expect(await titles({ limit: "0", offset: "3" })).toEqual({ titles: ["Delta", "Echo"], hasMore: false });
    });

    it("caps limit at 200", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Show",
        seasonNumber: 1,
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { limit: "999" },
      });
      const body = await expectJson<{
        pagination: { limit: number };
      }>(response, 200);

      expect(body.pagination.limit).toBe(200);
    });

    it("returns all items when limit=0", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      for (let i = 1; i <= 5; i++) {
        await createTestMediaItem(lib.id, {
          title: `Ep1`,
          type: "SERIES",
          parentTitle: `Show ${String(i).padStart(2, "0")}`,
          seasonNumber: 1,
          ratingKey: `rk-${i}`,
        });
      }

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { limit: "0" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.series.map((s) => s.parentTitle)).toEqual([
        "Show 01", "Show 02", "Show 03", "Show 04", "Show 05",
      ]);
      expect(body.pagination.limit).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  // ─── Filtering ───

  describe("filtering", () => {
    it("filters by startsWith letter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        ratingKey: "rk-arrow",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        ratingKey: "rk-bb",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Better Call Saul",
        seasonNumber: 1,
        ratingKey: "rk-bcs",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { startsWith: "B" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(2);
      const titles = body.series.map((s) => s.parentTitle).sort();
      expect(titles).toEqual(["Better Call Saul", "Breaking Bad"]);
    });

    it("filters by startsWith # for non-alphabetic titles", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "24",
        seasonNumber: 1,
        ratingKey: "rk-24",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "90210",
        seasonNumber: 1,
        ratingKey: "rk-90210",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        ratingKey: "rk-arrow",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { startsWith: "#" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(2);
      const titles = body.series.map((s) => s.parentTitle).sort();
      expect(titles).toEqual(["24", "90210"]);
    });

    it("filters by search parameter (case-insensitive parentTitle match)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        ratingKey: "rk-bb",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "The Wire",
        seasonNumber: 1,
        ratingKey: "rk-wire",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { search: "breaking" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].parentTitle).toBe("Breaking Bad");
    });

    it("combines startsWith and search filters", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        ratingKey: "rk-bb",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Better Call Saul",
        seasonNumber: 1,
        ratingKey: "rk-bcs",
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        ratingKey: "rk-arrow",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { startsWith: "B", search: "bad" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].parentTitle).toBe("Breaking Bad");
    });

    // The Series page sent no filter at all and filtered resolution, dates and
    // search on the client — every other filter in its panel did nothing.
    describe("library filters", () => {
      async function twoShows() {
        const user = await createTestUser();
        const server = await createTestServer(user.id);
        const lib = await createTestLibrary(server.id, { type: "SERIES" });
        // Drama: one 4K episode of three, all watched, genre Drama.
        for (let ep = 1; ep <= 3; ep++) {
          await createTestMediaItem(lib.id, {
            title: `D${ep}`, type: "SERIES", parentTitle: "Drama Show", seasonNumber: 1, episodeNumber: ep,
            resolution: ep === 1 ? "4k" : "1080", genres: ["Drama"], playCount: 1,
          });
        }
        // Comedy: one 1080p episode, unwatched, genre Comedy.
        await createTestMediaItem(lib.id, {
          title: "C1", type: "SERIES", parentTitle: "Comedy Show", seasonNumber: 1, episodeNumber: 1,
          resolution: "1080", genres: ["Comedy"], playCount: 0,
        });
        setMockSession({ userId: user.id, isLoggedIn: true });
      }

      const titles = async (searchParams: Record<string, string>) => {
        const response = await callRoute(GET, { url: "/api/media/series/grouped", searchParams });
        const body = await expectJson<{
          series: { parentTitle: string; episodeCount: number; qualityCounts: Record<string, number> }[];
        }>(response, 200);
        return body.series;
      };

      it("applies a per-episode filter as 'any episode matches', keeping the show's own figures", async () => {
        await twoShows();
        const series = await titles({ resolution: "4K" });
        expect(series.map((s) => s.parentTitle)).toEqual(["Drama Show"]);
        // Whole-show figures, not just the matching episode's.
        expect(series[0].episodeCount).toBe(3);
        expect(series[0].qualityCounts).toEqual({ "4K": 1, "1080P": 2 });
      });

      it("applies the common filters the library panel offers (genre)", async () => {
        await twoShows();
        expect((await titles({ genre: "Comedy" })).map((s) => s.parentTitle)).toEqual(["Comedy Show"]);
      });

      it("applies the show-level filters", async () => {
        await twoShows();
        expect((await titles({ episodeCountConditions: "gte:2" })).map((s) => s.parentTitle)).toEqual(["Drama Show"]);
        expect(
          (await titles({ watchedEpisodePercentageConditions: "lt:50" })).map((s) => s.parentTitle),
        ).toEqual(["Comedy Show"]);
      });

      it("returns nothing when no episode matches", async () => {
        await twoShows();
        expect(await titles({ genre: "Horror" })).toEqual([]);
      });

      // The page filtered resolution by its quality chips' labels before the
      // filter moved to the server; a PAL show stored as "576" is a 480P chip,
      // and the server's fixed spellings left it out of 480P and put it under
      // Other.
      it("matches a resolution by the label its quality chip shows", async () => {
        const user = await createTestUser();
        const server = await createTestServer(user.id);
        const lib = await createTestLibrary(server.id, { type: "SERIES" });
        await createTestMediaItem(lib.id, {
          title: "P1", type: "SERIES", parentTitle: "PAL Show", seasonNumber: 1, episodeNumber: 1, resolution: "576",
        });
        await createTestMediaItem(lib.id, {
          title: "H1", type: "SERIES", parentTitle: "HD Show", seasonNumber: 1, episodeNumber: 1, resolution: "1080",
        });
        // Its chip reads Other, so the Other filter keeps it.
        const unanalyzed = await createTestMediaItem(lib.id, {
          title: "U1", type: "SERIES", parentTitle: "Unanalyzed Show", seasonNumber: 1, episodeNumber: 1,
        });
        await getTestPrisma().mediaItem.update({ where: { id: unanalyzed.id }, data: { resolution: null } });
        setMockSession({ userId: user.id, isLoggedIn: true });

        const pal = (await titles({})).find((s) => s.parentTitle === "PAL Show");
        expect(pal?.qualityCounts).toEqual({ "480P": 1 });
        const unanalyzedShow = (await titles({})).find((s) => s.parentTitle === "Unanalyzed Show");
        expect(unanalyzedShow?.qualityCounts).toEqual({ Other: 1 });
        expect((await titles({ resolution: "480P" })).map((s) => s.parentTitle)).toEqual(["PAL Show"]);
        expect((await titles({ resolution: "Other" })).map((s) => s.parentTitle)).toEqual(["Unanalyzed Show"]);
        expect((await titles({ resolution: "480P|1080P" })).map((s) => s.parentTitle)).toEqual(["HD Show", "PAL Show"]);
      });

      // A date or watchlist filter is a fact about the SHOW (its latest play,
      // its newest addition), answered by `applySeriesFilters`. Applied per
      // episode as well, it was ANDed into the episode match, so beside any
      // other filter it demanded ONE episode that was both 4K and played
      // recently — dropping a show whose 4K episode was watched long ago and
      // whose latest play was last week, which the page used to list.
      it("answers a date filter beside an episode filter with the show's own figures", async () => {
        const user = await createTestUser();
        const server = await createTestServer(user.id);
        const lib = await createTestLibrary(server.id, { type: "SERIES" });
        await createTestMediaItem(lib.id, {
          title: "M1", type: "SERIES", parentTitle: "Mixed Show", seasonNumber: 1, episodeNumber: 1,
          resolution: "4k", lastPlayedAt: new Date("2022-01-10T12:00:00Z"),
        });
        await createTestMediaItem(lib.id, {
          title: "M2", type: "SERIES", parentTitle: "Mixed Show", seasonNumber: 1, episodeNumber: 2,
          resolution: "1080", lastPlayedAt: new Date("2024-06-10T12:00:00Z"),
        });
        // Unplayed 4K episode, the rest of the show last played in 2022.
        await createTestMediaItem(lib.id, {
          title: "O1", type: "SERIES", parentTitle: "Old Show", seasonNumber: 1, episodeNumber: 1,
          resolution: "4k",
        });
        await createTestMediaItem(lib.id, {
          title: "O2", type: "SERIES", parentTitle: "Old Show", seasonNumber: 1, episodeNumber: 2,
          resolution: "1080", lastPlayedAt: new Date("2022-03-10T12:00:00Z"),
        });
        setMockSession({ userId: user.id, isLoggedIn: true });

        // Mixed Show has 4K and was last played in 2024.
        expect(
          (await titles({ resolution: "4K", lastPlayedAtMin: "2024-01-01" })).map((s) => s.parentTitle),
        ).toEqual(["Mixed Show"]);
        // Old Show has 4K and has not been played since 2022.
        expect(
          (await titles({ resolution: "4K", lastPlayedAtMax: "2023-01-01" })).map((s) => s.parentTitle),
        ).toEqual(["Old Show"]);
      });

      // A date bound is a UTC calendar day, as on All Seasons and every flat
      // list. Ended at local midnight instead, a server west of UTC dropped a
      // show played on the bound's own day from the Series tab only.
      it("ends a date bound at the end of its UTC day whatever the server's time zone", async () => {
        const tz = process.env.TZ;
        process.env.TZ = "America/New_York";
        try {
          const user = await createTestUser();
          const server = await createTestServer(user.id);
          const lib = await createTestLibrary(server.id, { type: "SERIES" });
          await createTestMediaItem(lib.id, {
            title: "E1", type: "SERIES", parentTitle: "Boundary Show", seasonNumber: 1, episodeNumber: 1,
            lastPlayedAt: new Date("2023-01-01T15:00:00Z"),
          });
          setMockSession({ userId: user.id, isLoggedIn: true });

          expect((await titles({ lastPlayedAtMax: "2023-01-01" })).map((s) => s.parentTitle)).toEqual(["Boundary Show"]);
          expect(await titles({ lastPlayedAtMax: "2022-12-31" })).toEqual([]);
        } finally {
          if (tz === undefined) delete process.env.TZ;
          else process.env.TZ = tz;
        }
      });
    });
  });

  // ─── Sorting ───

  describe("sorting", () => {
    it("sorts by parentTitle ascending by default", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Charlie",
        seasonNumber: 1,
        ratingKey: "rk-c",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Alpha",
        seasonNumber: 1,
        ratingKey: "rk-a",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Bravo",
        seasonNumber: 1,
        ratingKey: "rk-b",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series.map((s) => s.parentTitle)).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
    });

    it("sorts by parentTitle descending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Alpha",
        seasonNumber: 1,
        ratingKey: "rk-a",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Bravo",
        seasonNumber: 1,
        ratingKey: "rk-b",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "parentTitle", sortOrder: "desc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series.map((s) => s.parentTitle)).toEqual([
        "Bravo",
        "Alpha",
      ]);
    });

    it("sorts by episodeCount descending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Show A: 1 episode
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Show A",
        seasonNumber: 1,
        ratingKey: "rk-a1",
      });

      // Show B: 3 episodes
      for (let i = 1; i <= 3; i++) {
        await createTestMediaItem(lib.id, {
          title: `Ep${i}`,
          type: "SERIES",
          parentTitle: "Show B",
          seasonNumber: 1,
          episodeNumber: i,
          ratingKey: `rk-b${i}`,
        });
      }

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "episodeCount", sortOrder: "desc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string; episodeCount: number }[];
      }>(response, 200);

      expect(body.series.map((s) => [s.parentTitle, s.episodeCount])).toEqual([
        ["Show B", 3],
        ["Show A", 1],
      ]);
    });

    it("sorts by totalSize ascending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Big Show",
        seasonNumber: 1,
        fileSize: BigInt("10737418240"),
        ratingKey: "rk-big",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Small Show",
        seasonNumber: 1,
        fileSize: BigInt("536870912"),
        ratingKey: "rk-small",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "totalSize", sortOrder: "asc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string; totalSize: string }[];
      }>(response, 200);

      expect(body.series.map((s) => [s.parentTitle, s.totalSize])).toEqual([
        ["Small Show", "536870912"],
        ["Big Show", "10737418240"],
      ]);
    });
  });

  // ─── Quality counts ───

  describe("quality counts", () => {
    it("includes resolution quality counts per series group", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Mixed Quality Show",
        seasonNumber: 1,
        episodeNumber: 1,
        resolution: "1080p",
        ratingKey: "rk-1",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep2",
        type: "SERIES",
        parentTitle: "Mixed Quality Show",
        seasonNumber: 1,
        episodeNumber: 2,
        resolution: "4k",
        ratingKey: "rk-2",
      });
      await createTestMediaItem(lib.id, {
        title: "Ep3",
        type: "SERIES",
        parentTitle: "Mixed Quality Show",
        seasonNumber: 1,
        episodeNumber: 3,
        resolution: "1080p",
        ratingKey: "rk-3",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: {
          parentTitle: string;
          qualityCounts: Record<string, number>;
        }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].qualityCounts).toEqual({ "1080P": 2, "4K": 1 });
    });
  });

  // ─── Server info ───

  describe("server info", () => {
    it("includes server presence for each series group", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "Home Plex" });
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      const pilot = await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: {
          parentTitle: string;
          servers: { serverId: string; serverName: string; serverType: string; mediaItemId: string }[];
        }[];
      }>(response, 200);

      expect(body.series[0].servers).toEqual([
        { serverId: server.id, serverName: "Home Plex", serverType: "PLEX", mediaItemId: pilot.id },
      ]);
    });
  });

  // ─── Series identity (seriesKey) ───

  describe("series identity", () => {
    it("splits two same-titled shows with different seriesKeys into two rows", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // The Office (UK) — 1 episode.
      await createTestMediaItem(lib.id, {
        title: "Downsize", type: "SERIES", parentTitle: "The Office",
        seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1,
      });
      // The Office (US) — 2 episodes across 2 seasons.
      await createTestMediaItem(lib.id, {
        title: "Pilot", type: "SERIES", parentTitle: "The Office",
        seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "Finale", type: "SERIES", parentTitle: "The Office",
        seriesKey: "tvdb:73244", seasonNumber: 9, episodeNumber: 23,
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const body = await expectJson<{
        series: { parentTitle: string; seriesKey: string; episodeCount: number; seasonCount: number }[];
      }>(await callRoute(GET, { url: "/api/media/series/grouped", searchParams: { limit: "0" } }), 200);

      // Two rows despite the shared title.
      expect(body.series).toHaveLength(2);
      const byKey = new Map(body.series.map((s) => [s.seriesKey, s]));
      expect(byKey.get("tvdb:78107")!.episodeCount).toBe(1);
      expect(byKey.get("tvdb:78107")!.seasonCount).toBe(1);
      expect(byKey.get("tvdb:73244")!.episodeCount).toBe(2);
      expect(byKey.get("tvdb:73244")!.seasonCount).toBe(2);
      // Both still display "The Office".
      expect(body.series.every((s) => s.parentTitle === "The Office")).toBe(true);
    });

    // Rows tying on the sort (here: the title) used to come back in whatever
    // order the GROUP BY produced, so a page boundary between same-titled shows
    // could move between requests. The aggregate is ordered by seriesKey and
    // the sort is stable, so ties are in seriesKey order and pages tile.
    it("orders shows that tie on the sort by seriesKey, so pages do not shuffle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      for (const key of ["tvdb:300", "tvdb:100", "tvdb:400", "tvdb:200"]) {
        await createTestMediaItem(lib.id, {
          title: "Pilot", type: "SERIES", parentTitle: "Battlestar Galactica",
          seriesKey: key, seasonNumber: 1, episodeNumber: 1,
        });
      }
      setMockSession({ userId: user.id, isLoggedIn: true });

      const keys = async (searchParams: Record<string, string>) =>
        (await expectJson<{ series: { seriesKey: string }[] }>(
          await callRoute(GET, { url: "/api/media/series/grouped", searchParams }),
          200,
        )).series.map((s) => s.seriesKey);

      const expected = ["tvdb:100", "tvdb:200", "tvdb:300", "tvdb:400"];
      const spy = reverseUnorderedRawRows();
      try {
        expect(await keys({ limit: "0" })).toEqual(expected);
        expect(await keys({ limit: "0", sortBy: "episodeCount", sortOrder: "desc" })).toEqual(expected);
        const paged: string[] = [];
        for (let page = 1; page <= 4; page++) paged.push(...(await keys({ limit: "1", page: String(page) })));
        expect(paged).toEqual(expected);
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps the same show on two servers as one row (cross-server merge)", async () => {
      const user = await createTestUser();
      const server1 = await createTestServer(user.id, { name: "Plex" });
      const server2 = await createTestServer(user.id, { name: "Jellyfin" });
      const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
      const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

      // Same episode of the same show on both servers, different title spelling,
      // shared TVDB-derived seriesKey and dedupKey.
      await createTestMediaItem(lib1.id, {
        title: "33", type: "SERIES", parentTitle: "Battlestar Galactica",
        seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
      });
      await createTestMediaItem(lib2.id, {
        title: "33", type: "SERIES", parentTitle: "battlestar galactica ",
        seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
      });
      // Multi-server listings show only canonical copies; mark one canonical and
      // the other not, as recomputeCanonical would (shared dedupKey).
      const prisma = (await import("../../setup/test-db")).getTestPrisma();
      await prisma.mediaItem.updateMany({ data: { dedupKey: "series:tvdb:73545:s1e1" } });
      const rows = await prisma.mediaItem.findMany({ orderBy: { id: "asc" } });
      await prisma.mediaItem.update({ where: { id: rows[0].id }, data: { dedupCanonical: true } });
      await prisma.mediaItem.update({ where: { id: rows[1].id }, data: { dedupCanonical: false } });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const body = await expectJson<{
        series: { seriesKey: string; episodeCount: number; servers: { serverName: string }[] }[];
      }>(await callRoute(GET, { url: "/api/media/series/grouped", searchParams: { limit: "0" } }), 200);

      // One merged row (not two), counting the single canonical episode, with
      // both servers listed in its presence.
      expect(body.series).toHaveLength(1);
      expect(body.series[0].seriesKey).toBe("tvdb:73545");
      expect(body.series[0].episodeCount).toBe(1);
      expect(body.series[0].servers.map((s) => s.serverName).sort()).toEqual(["Jellyfin", "Plex"]);
    });

    it("gives each show the same presence whether the listing is whole, paged, searched or filtered", async () => {
      const user = await createTestUser();
      const plex = await createTestServer(user.id, { name: "Plex" });
      const jelly = await createTestServer(user.id, { name: "Jellyfin" });
      const libP = await createTestLibrary(plex.id, { type: "SERIES" });
      const libJ = await createTestLibrary(jelly.id, { type: "SERIES" });
      // Alpha and Gamma on both servers, Beta on Plex only; Gamma in 4K.
      const shows = [
        { key: "tvdb:1", title: "Alpha", libs: [libP, libJ], resolution: "1080" },
        { key: "tvdb:2", title: "Beta", libs: [libP], resolution: "1080" },
        { key: "tvdb:3", title: "Gamma", libs: [libP, libJ], resolution: "2160" },
      ];
      for (const show of shows) {
        for (const lib of show.libs) {
          const item = await createTestMediaItem(lib.id, {
            type: "SERIES", parentTitle: show.title, seriesKey: show.key,
            seasonNumber: 1, episodeNumber: 1, resolution: show.resolution,
          });
          // One canonical copy per show, as recomputeCanonical leaves it.
          await getTestPrisma().mediaItem.update({
            where: { id: item.id },
            data: { dedupKey: `${show.key}:s1e1`, dedupCanonical: lib === show.libs[0] },
          });
        }
      }
      setMockSession({ userId: user.id, isLoggedIn: true });

      type Row = { seriesKey: string; servers: { serverName: string; mediaItemId: string }[] };
      const list = async (searchParams: Record<string, string>) =>
        (await expectJson<{ series: Row[] }>(await callRoute(GET, { url: "/api/media/series/grouped", searchParams }), 200)).series;
      const whole = new Map((await list({ limit: "0" })).map((r) => [r.seriesKey, r.servers]));
      expect(whole.get("tvdb:1")!.map((s) => s.serverName)).toEqual(["Jellyfin", "Plex"]);
      expect(whole.get("tvdb:2")!.map((s) => s.serverName)).toEqual(["Plex"]);

      const cases: Record<string, string>[] = [
        { limit: "1", page: "2" },
        { limit: "0", search: "amm" },
        { limit: "0", startsWith: "B" },
        { limit: "0", resolution: "4K" },
        { limit: "2", resolution: "4K|1080P" },
      ];
      for (const params of cases) {
        const rows = await list(params);
        expect(rows.length, JSON.stringify(params)).toBeGreaterThan(0);
        for (const row of rows) expect(row.servers, JSON.stringify(params)).toEqual(whole.get(row.seriesKey));
      }
    });
  });
});
