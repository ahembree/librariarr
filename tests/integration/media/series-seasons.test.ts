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
import { GET } from "@/app/api/media/series/seasons/route";

describe("GET /api/media/series/seasons", () => {
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
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when parentTitle is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("parentTitle is required");
  });

  it("returns empty seasons when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show" },
    });
    const body = await expectJson<{ seasons: unknown[] }>(response, 200);
    expect(body.seasons).toEqual([]);
  });

  it("groups episodes by season number for a given series", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Season 1: 2 episodes
    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
      resolution: "1080p",
      fileSize: BigInt("500000000"),
      playCount: 5,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
      resolution: "1080p",
      fileSize: BigInt("600000000"),
      playCount: 3,
    });

    // Season 2: 1 episode
    await createTestMediaItem(lib.id, {
      title: "S2Ep1",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 2,
      episodeNumber: 1,
      resolution: "4k",
      fileSize: BigInt("2000000000"),
      playCount: 1,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Breaking Bad" },
    });
    const body = await expectJson<{
      seasons: {
        seasonNumber: number;
        episodeCount: number;
        totalSize: string;
        totalPlayCount: number;
        qualityCounts: Record<string, number>;
      }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(2);

    // Sorted by seasonNumber ascending
    expect(body.seasons[0].seasonNumber).toBe(1);
    expect(body.seasons[0].episodeCount).toBe(2);
    expect(body.seasons[0].totalSize).toBe("1100000000");
    expect(body.seasons[0].totalPlayCount).toBe(8);

    expect(body.seasons[1].seasonNumber).toBe(2);
    expect(body.seasons[1].episodeCount).toBe(1);
    expect(body.seasons[1].totalSize).toBe("2000000000");
    expect(body.seasons[1].totalPlayCount).toBe(1);
  });

  it("does not include episodes from other series", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show B",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show A" },
    });
    const body = await expectJson<{
      seasons: { seasonNumber: number; episodeCount: number }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0].episodeCount).toBe(1);
  });

  it("tracks quality counts per season", async () => {
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
    await createTestMediaItem(lib.id, {
      title: "Ep3",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 3,
      resolution: "1080p",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show" },
    });
    const body = await expectJson<{
      seasons: { qualityCounts: Record<string, number> }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    const qc = body.seasons[0].qualityCounts;
    // Should have 2 different resolution labels
    expect(Object.keys(qc).length).toBe(2);
  });

  it("tracks lastPlayed as the most recent across episodes", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    const older = new Date("2024-01-01T00:00:00Z");
    const newer = new Date("2024-06-15T00:00:00Z");

    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
      lastPlayedAt: older,
      playCount: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 2,
      lastPlayedAt: newer,
      playCount: 1,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show" },
    });
    const body = await expectJson<{
      seasons: { lastPlayed: string | null }[];
    }>(response, 200);

    expect(body.seasons[0].lastPlayed).toBe(newer.toISOString());
  });

  it("handles episodes with null seasonNumber as season 0", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Special",
      type: "SERIES",
      parentTitle: "Show",
      episodeNumber: 1,
      // seasonNumber is undefined => null => grouped as 0
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/series/seasons",
      searchParams: { parentTitle: "Show" },
    });
    const body = await expectJson<{
      seasons: { seasonNumber: number }[];
    }>(response, 200);

    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0].seasonNumber).toBe(0);
  });
});
