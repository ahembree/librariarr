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
import { GET } from "@/app/api/media/stats/cross-tab/route";

describe("GET /api/media/stats/cross-tab", () => {
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
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "resolution", dimension2: "videoCodec" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when dimensions are missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Missing dimension1 or dimension2");
  });

  it("returns 400 when dimensions are the same", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "resolution", dimension2: "resolution" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Dimensions must differ");
  });

  it("returns 400 for invalid dimension IDs", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "nonexistent", dimension2: "videoCodec" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid dimension");
  });

  it("returns 400 when crossing two stream dimensions", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "audioLanguage", dimension2: "subtitleLanguage" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Cannot cross two stream dimensions");
  });

  it("returns empty rows when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "resolution", dimension2: "videoCodec" },
    });
    const body = await expectJson<{ rows: unknown[] }>(response, 200);
    expect(body.rows).toEqual([]);
  });

  it("returns cross-tab data for two direct dimensions", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    await createTestMediaItem(lib.id, {
      title: "Movie A",
      type: "MOVIE",
      resolution: "1080p",
      videoCodec: "h264",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie B",
      type: "MOVIE",
      resolution: "1080p",
      videoCodec: "h265",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie C",
      type: "MOVIE",
      resolution: "4k",
      videoCodec: "h265",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "videoCodec", dimension2: "dynamicRange" },
    });
    const body = await expectJson<{
      rows: { dim1: string; dim2: string; type: string; _count: number }[];
    }>(response, 200);

    expect(body.rows.length).toBeGreaterThan(0);
    // All items should be type MOVIE
    for (const row of body.rows) {
      expect(row.type).toBe("MOVIE");
      expect(row._count).toBeGreaterThan(0);
    }
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: {
        dimension1: "resolution",
        dimension2: "videoCodec",
        serverId: server.id,
      },
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
      url: "/api/media/stats/cross-tab",
      searchParams: {
        dimension1: "videoCodec",
        dimension2: "dynamicRange",
        serverId: server1.id,
      },
    });
    const body = await expectJson<{
      rows: { dim1: string; dim2: string; _count: number }[];
    }>(response, 200);

    // Should only have data from server1
    expect(body.rows.length).toBeGreaterThan(0);
    const codecs = body.rows.map((r) => r.dim1);
    expect(codecs).toContain("h264");
    expect(codecs).not.toContain("h265");
  });
});
