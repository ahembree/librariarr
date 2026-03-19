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
import { GET } from "@/app/api/media/series/all-seasons/route";

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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{ seasons: unknown[] }>(response, 200);
    expect(body.seasons).toEqual([]);
  });

  it("groups episodes by parentTitle and seasonNumber", async () => {
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    expect(body.seasons).toHaveLength(2);

    // Default sort is by parentTitle then seasonNumber
    const s1 = body.seasons.find((s) => s.seasonNumber === 1);
    expect(s1).toBeDefined();
    expect(s1!.parentTitle).toBe("Show A");
    expect(s1!.episodeCount).toBe(2);
    expect(s1!.totalSize).toBe("1100000000");
    expect(s1!.totalPlayCount).toBe(4);

    const s2 = body.seasons.find((s) => s.seasonNumber === 2);
    expect(s2).toBeDefined();
    expect(s2!.episodeCount).toBe(1);
    expect(s2!.totalSize).toBe("2000000000");
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
      searchParams: { sortBy: "episodeCount", sortOrder: "desc" },
    });
    const body = await expectJson<{
      seasons: { parentTitle: string; episodeCount: number }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(2);
    expect(body.seasons[0].episodeCount).toBe(3);
    expect(body.seasons[1].episodeCount).toBe(1);
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{
      seasons: { qualityCounts: Record<string, number> }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    const qc = body.seasons[0].qualityCounts;
    // normalizeResolutionLabel maps these to display labels
    expect(Object.keys(qc).length).toBe(2);
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/all-seasons",
    });
    const body = await expectJson<{
      seasons: { totalSize: string }[];
    }>(response, 200);

    expect(typeof body.seasons[0].totalSize).toBe("string");
    expect(body.seasons[0].totalSize).toBe("10737418240");
  });
});
