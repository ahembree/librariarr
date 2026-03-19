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
import { GET } from "@/app/api/media/stats/custom/route";

describe("GET /api/media/stats/custom", () => {
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
      url: "/api/media/stats/custom",
      searchParams: { dimension: "resolution" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when dimension is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Missing dimension parameter");
  });

  it("returns 400 for invalid dimension ID", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "nonexistent" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid dimension");
  });

  it("returns empty breakdown when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "resolution" },
    });
    const body = await expectJson<{ breakdown: unknown[] }>(response, 200);
    expect(body.breakdown).toEqual([]);
  });

  it("returns breakdown for a direct dimension (videoCodec)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    await createTestMediaItem(lib.id, {
      title: "Movie A",
      type: "MOVIE",
      videoCodec: "h264",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie B",
      type: "MOVIE",
      videoCodec: "h264",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie C",
      type: "MOVIE",
      videoCodec: "h265",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "videoCodec" },
    });
    const body = await expectJson<{
      breakdown: { value: string | null; type: string; _count: number }[];
    }>(response, 200);

    expect(body.breakdown.length).toBeGreaterThan(0);

    const h264 = body.breakdown.find((b) => b.value === "h264");
    expect(h264).toBeDefined();
    expect(h264!._count).toBe(2);
    expect(h264!.type).toBe("MOVIE");

    const h265 = body.breakdown.find((b) => b.value === "h265");
    expect(h265).toBeDefined();
    expect(h265!._count).toBe(1);
  });

  it("returns breakdown for a value_map dimension (resolution)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    await createTestMediaItem(lib.id, {
      title: "Movie 4K",
      type: "MOVIE",
      resolution: "4k",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 1080",
      type: "MOVIE",
      resolution: "1080p",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 1080 2",
      type: "MOVIE",
      resolution: "1080p",
      ratingKey: "m1080-2",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "resolution" },
    });
    const body = await expectJson<{
      breakdown: { value: string | null; type: string; _count: number }[];
    }>(response, 200);

    expect(body.breakdown.length).toBeGreaterThan(0);

    // value_map normalizes resolution labels
    const res4k = body.breakdown.find((b) => b.value === "4K");
    expect(res4k).toBeDefined();
    expect(res4k!._count).toBe(1);

    const res1080 = body.breakdown.find((b) => b.value === "1080P");
    expect(res1080).toBeDefined();
    expect(res1080!._count).toBe(2);
  });

  it("returns breakdown for a json_unnest dimension (genre)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    await createTestMediaItem(lib.id, {
      title: "Action Movie",
      type: "MOVIE",
      genres: ["Action", "Sci-Fi"],
    });
    await createTestMediaItem(lib.id, {
      title: "Action Comedy",
      type: "MOVIE",
      genres: ["Action", "Comedy"],
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "genre" },
    });
    const body = await expectJson<{
      breakdown: { value: string; type: string; _count: number }[];
    }>(response, 200);

    expect(body.breakdown.length).toBeGreaterThan(0);

    const action = body.breakdown.find((b) => b.value === "Action");
    expect(action).toBeDefined();
    expect(action!._count).toBe(2);

    const scifi = body.breakdown.find((b) => b.value === "Sci-Fi");
    expect(scifi).toBeDefined();
    expect(scifi!._count).toBe(1);
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "resolution", serverId: server.id },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("filters by serverId", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "S1" });
    const server2 = await createTestServer(user.id, { name: "S2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createTestMediaItem(lib1.id, {
      title: "S1 Movie",
      type: "MOVIE",
      videoCodec: "h264",
    });
    await createTestMediaItem(lib2.id, {
      title: "S2 Movie",
      type: "MOVIE",
      videoCodec: "h265",
      ratingKey: "s2m1",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "videoCodec", serverId: server1.id },
    });
    const body = await expectJson<{
      breakdown: { value: string | null; type: string; _count: number }[];
    }>(response, 200);

    expect(body.breakdown).toHaveLength(1);
    expect(body.breakdown[0].value).toBe("h264");
    expect(body.breakdown[0]._count).toBe(1);
  });

  it("returns breakdown across multiple media types", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(movieLib.id, {
      title: "Movie",
      type: "MOVIE",
      container: "mkv",
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Episode",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
      container: "mkv",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/custom",
      searchParams: { dimension: "container" },
    });
    const body = await expectJson<{
      breakdown: { value: string; type: string; _count: number }[];
    }>(response, 200);

    // Should have mkv entries for both MOVIE and SERIES types
    const mkvRows = body.breakdown.filter((b) => b.value === "mkv");
    expect(mkvRows).toHaveLength(2);
    const types = mkvRows.map((r) => r.type).sort();
    expect(types).toEqual(["MOVIE", "SERIES"]);
  });
});
