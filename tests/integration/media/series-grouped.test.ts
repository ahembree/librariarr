import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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
import { GET } from "@/app/api/media/series/grouped/route";

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
    it("groups episodes by parentTitle with correct counts", async () => {
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      expect(body.series).toHaveLength(2);

      const bb = body.series.find((s) => s.parentTitle === "Breaking Bad");
      expect(bb).toBeDefined();
      expect(bb!.episodeCount).toBe(3);
      expect(bb!.seasonCount).toBe(2);
      // 1GB + 1GB + 4GB = 6GB = 6442450944 bytes
      expect(bb!.totalSize).toBe("6442450944");

      const wire = body.series.find((s) => s.parentTitle === "The Wire");
      expect(wire).toBeDefined();
      expect(wire!.episodeCount).toBe(1);
      expect(wire!.seasonCount).toBe(1);
      expect(wire!.qualityCounts["720P"]).toBe(1);
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { totalSize: string }[];
      }>(response, 200);

      expect(body.series[0].totalSize).toBe("10737418240");
      expect(typeof body.series[0].totalSize).toBe("string");
    });

    it("does not return series from other users' servers", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server1 = await createTestServer(user1.id);
      const server2 = await createTestServer(user2.id);
      const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
      const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

      await createTestMediaItem(lib1.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "User1 Show",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib2.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "User2 Show",
        seasonNumber: 1,
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].parentTitle).toBe("User1 Show");
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Page 1, limit 2
      const response1 = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { page: "1", limit: "2" },
      });
      const body1 = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response1, 200);

      expect(body1.series).toHaveLength(2);
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

      expect(body2.series).toHaveLength(2);
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

      expect(body3.series).toHaveLength(1);
      expect(body3.pagination.hasMore).toBe(false);
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { limit: "0" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
        pagination: { limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.series).toHaveLength(5);
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "episodeCount", sortOrder: "desc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string; episodeCount: number }[];
      }>(response, 200);

      expect(body.series[0].parentTitle).toBe("Show B");
      expect(body.series[0].episodeCount).toBe(3);
      expect(body.series[1].parentTitle).toBe("Show A");
      expect(body.series[1].episodeCount).toBe(1);
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "totalSize", sortOrder: "asc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string; totalSize: string }[];
      }>(response, 200);

      expect(body.series[0].parentTitle).toBe("Small Show");
      expect(body.series[1].parentTitle).toBe("Big Show");
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: {
          parentTitle: string;
          qualityCounts: Record<string, number>;
        }[];
      }>(response, 200);

      const show = body.series[0];
      expect(show.qualityCounts["1080P"]).toBe(2);
      expect(show.qualityCounts["4K"]).toBe(1);
    });
  });

  // ─── Server info ───

  describe("server info", () => {
    it("includes server presence for each series group", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "Home Plex" });
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: {
          parentTitle: string;
          servers: { serverId: string; serverName: string }[];
        }[];
      }>(response, 200);

      expect(body.series[0].servers).toHaveLength(1);
      expect(body.series[0].servers[0].serverName).toBe("Home Plex");
    });
  });
});
