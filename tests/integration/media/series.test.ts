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

// Import route handlers AFTER mocks
import { GET } from "@/app/api/media/series/route";
import { GET as GET_GROUPED } from "@/app/api/media/series/grouped/route";

describe("Series endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/media/series (episodes) -----

  describe("GET /api/media/series", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/media/series" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty items when no series data exists", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/series" });
      const body = await expectJson<{
        items: unknown[];
        pagination: { hasMore: boolean };
      }>(response, 200);

      expect(body.items).toEqual([]);
      expect(body.pagination.hasMore).toBe(false);
    });

    it("returns only SERIES type items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });
      const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(movieLib.id, {
        title: "Some Movie",
        type: "MOVIE",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/series" });
      const body = await expectJson<{
        items: { title: string; type: string }[];
        pagination: { hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("Pilot");
      expect(body.pagination.hasMore).toBe(false);
    });

    it("filters by parentTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Breaking Bad",
      });
      await createTestMediaItem(lib.id, {
        title: "Winter Is Coming",
        type: "SERIES",
        parentTitle: "Game of Thrones",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series",
        searchParams: { parentTitle: "Breaking Bad" },
      });
      const body = await expectJson<{
        items: { parentTitle: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].parentTitle).toBe("Breaking Bad");
    });

    it("filters by seasonNumber", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Show",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "S02E01",
        type: "SERIES",
        parentTitle: "Show",
        seasonNumber: 2,
        episodeNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series",
        searchParams: { seasonNumber: "1" },
      });
      const body = await expectJson<{
        items: { seasonNumber: number }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].seasonNumber).toBe(1);
    });

    it("searches across title and parentTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Breaking Bad",
      });
      await createTestMediaItem(lib.id, {
        title: "Breaking Point",
        type: "SERIES",
        parentTitle: "Other Show",
      });
      await createTestMediaItem(lib.id, {
        title: "Unrelated",
        type: "SERIES",
        parentTitle: "Unrelated Show",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series",
        searchParams: { search: "breaking" },
      });
      const body = await expectJson<{
        items: { title: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(2);
    });

    it("serializes BigInt fileSize to string", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Episode",
        type: "SERIES",
        parentTitle: "Show",
        fileSize: BigInt("2147483648"),
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/series" });
      const body = await expectJson<{
        items: { fileSize: string }[];
      }>(response, 200);

      expect(body.items[0].fileSize).toBe("2147483648");
      expect(typeof body.items[0].fileSize).toBe("string");
    });
  });

  // ----- GET /api/media/series/grouped -----

  describe("GET /api/media/series/grouped", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty series list when no data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{ series: unknown[] }>(response, 200);

      expect(body.series).toEqual([]);
    });

    it("groups episodes by parentTitle with correct counts", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Breaking Bad: 2 episodes across 2 seasons
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
        title: "Face Off",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 4,
        episodeNumber: 13,
        resolution: "1080p",
        fileSize: BigInt("2147483648"),
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

      const response = await callRoute(GET_GROUPED, {
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
      expect(bb!.episodeCount).toBe(2);
      expect(bb!.seasonCount).toBe(2);
      expect(bb!.totalSize).toBe("3221225472"); // 1GB + 2GB
      expect(bb!.qualityCounts["1080P"]).toBe(2);

      const wire = body.series.find((s) => s.parentTitle === "The Wire");
      expect(wire).toBeDefined();
      expect(wire!.episodeCount).toBe(1);
      expect(wire!.seasonCount).toBe(1);
      expect(wire!.qualityCounts["720P"]).toBe(1);
    });

    it("supports search by parentTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "The Wire",
        seasonNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/series/grouped",
        searchParams: { search: "breaking" },
      });
      const body = await expectJson<{
        series: { parentTitle: string }[];
      }>(response, 200);

      expect(body.series).toHaveLength(1);
      expect(body.series[0].parentTitle).toBe("Breaking Bad");
    });

    it("supports sorting by episodeCount desc", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Show A: 1 episode
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Show A",
        seasonNumber: 1,
      });

      // Show B: 3 episodes
      for (let i = 1; i <= 3; i++) {
        await createTestMediaItem(lib.id, {
          title: `Ep${i}`,
          type: "SERIES",
          parentTitle: "Show B",
          seasonNumber: 1,
          episodeNumber: i,
          ratingKey: `show-b-${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/series/grouped",
        searchParams: { sortBy: "episodeCount", sortOrder: "desc" },
      });
      const body = await expectJson<{
        series: { parentTitle: string; episodeCount: number }[];
      }>(response, 200);

      expect(body.series[0].parentTitle).toBe("Show B");
      expect(body.series[0].episodeCount).toBe(3);
      expect(body.series[1].parentTitle).toBe("Show A");
    });

    it("serializes totalSize as string (BigInt)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep",
        type: "SERIES",
        parentTitle: "BigShow",
        seasonNumber: 1,
        fileSize: BigInt("10737418240"),
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/series/grouped",
      });
      const body = await expectJson<{
        series: { totalSize: string }[];
      }>(response, 200);

      expect(body.series[0].totalSize).toBe("10737418240");
      expect(typeof body.series[0].totalSize).toBe("string");
    });

    it("filters grouped series by startsWith letter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "Better Call Saul",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "Ep1",
        type: "SERIES",
        parentTitle: "The Wire",
        seasonNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
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
  });

  // ----- GET /api/media/series (pagination fix) -----

  describe("GET /api/media/series pagination", () => {
    it("returns total and pages in pagination response", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      for (let i = 1; i <= 5; i++) {
        await createTestMediaItem(lib.id, {
          title: `Episode ${i}`,
          type: "SERIES",
          parentTitle: "Show",
          seasonNumber: 1,
          episodeNumber: i,
          ratingKey: `rk-${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/series",
        searchParams: { limit: "2" },
      });
      const body = await expectJson<{
        items: unknown[];
        pagination: { page: number; limit: number; total: number; pages: number; hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(2);
      expect(body.pagination.total).toBe(5);
      expect(body.pagination.pages).toBe(3);
      expect(body.pagination.hasMore).toBe(true);
    });
  });
});
