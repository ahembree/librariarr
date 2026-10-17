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
  createTestMediaStream,
} from "../../setup/test-helpers";
import { getTestPrisma } from "../../setup/test-db";

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
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Missing dimension1 or dimension2");
  });

  it("returns 400 when dimensions are the same", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "resolution", dimension2: "resolution" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Dimensions must differ");
  });

  it("returns 400 for invalid dimension IDs", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "nonexistent", dimension2: "videoCodec" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid dimension");
  });

  it("returns 400 when crossing two stream dimensions", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "audioLanguage", dimension2: "subtitleLanguage" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Cannot cross two stream dimensions");
  });

  it("returns empty rows when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

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
      dynamicRange: "SDR",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie B",
      type: "MOVIE",
      resolution: "1080p",
      videoCodec: "hevc",
      dynamicRange: "HDR10",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie C",
      type: "MOVIE",
      resolution: "4k",
      videoCodec: "hevc",
      dynamicRange: "HDR10",
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "videoCodec", dimension2: "dynamicRange" },
    });
    const body = await expectJson<{
      rows: { dim1: string; dim2: string; type: string; _count: number }[];
    }>(response, 200);

    expect([...body.rows].sort((a, b) => a.dim1.localeCompare(b.dim1))).toEqual([
      { dim1: "h264", dim2: "SDR", type: "MOVIE", _count: 1 },
      { dim1: "hevc", dim2: "HDR10", type: "MOVIE", _count: 2 },
    ]);
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, isLoggedIn: true });

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
      videoCodec: "hevc",
      ratingKey: "s2m1",
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

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

    // Only server1's movie.
    expect(body.rows).toEqual([{ dim1: "h264", dim2: "SDR", type: "MOVIE", _count: 1 }]);
  });

  it("counts an item once per stream language, not once per track", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    // Main audio and commentary, both English: one English item.
    const movie = await createTestMediaItem(lib.id, { type: "MOVIE", videoCodec: "h264" });
    await createTestMediaStream(movie.id, { streamType: 2, index: 1, language: "English" });
    await createTestMediaStream(movie.id, { streamType: 2, index: 2, language: "English" });
    await createTestMediaStream(movie.id, { streamType: 2, index: 3, language: "French" });

    setMockSession({ userId: user.id, isLoggedIn: true });
    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "audioLanguage", dimension2: "videoCodec" },
    });
    const body = await expectJson<{
      rows: { dim1: string; dim2: string; type: string; _count: number }[];
    }>(response, 200);

    expect([...body.rows].sort((a, b) => a.dim1.localeCompare(b.dim1))).toEqual([
      { dim1: "English", dim2: "h264", type: "MOVIE", _count: 1 },
      { dim1: "French", dim2: "h264", type: "MOVIE", _count: 1 },
    ]);
  });

  it("caps direct x direct cells per type, so a small type is not crowded out", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });

    // 2,100 distinct movie cells, each counted twice so they outrank the one
    // music cell — under an overall 2,000-row cap the music cell was dropped.
    const prisma = getTestPrisma();
    const rows = [];
    for (let i = 0; i < 2100; i++) {
      for (const copy of [0, 1]) {
        rows.push({
          libraryId: movies.id,
          ratingKey: `m-${i}-${copy}`,
          title: `Movie ${i}`,
          type: "MOVIE" as const,
          year: 1900 + (i % 100),
          studio: `Studio ${Math.floor(i / 100)}`,
        });
      }
    }
    await prisma.mediaItem.createMany({ data: rows });
    await createTestMediaItem(music.id, { type: "MUSIC", year: 1999, studio: "Label" });

    setMockSession({ userId: user.id, isLoggedIn: true });
    const response = await callRoute(GET, {
      url: "/api/media/stats/cross-tab",
      searchParams: { dimension1: "year", dimension2: "studio" },
    });
    const body = await expectJson<{
      rows: { dim1: string; dim2: string; type: string; _count: number }[];
    }>(response, 200);

    expect(body.rows.filter((r) => r.type === "MOVIE")).toHaveLength(2000);
    expect(body.rows.filter((r) => r.type === "MUSIC")).toEqual([
      { dim1: "1999", dim2: "Label", type: "MUSIC", _count: 1 },
    ]);
  });

  it("buckets dates in UTC, like the breakdown, whatever the process timezone", async () => {
    // The Unraid template defaults TZ=America/New_York. Bucketed in local time,
    // an item added 02:00 UTC on March 1st landed in February on the heatmap
    // while the Added Date breakdown (SQL TO_CHAR) put it in March.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id);
      await createTestMediaItem(library.id, {
        addedAt: new Date("2024-03-01T02:00:00Z"),
        videoCodec: "hevc",
      });

      const body = await expectJson<{ rows: { dim1: string | null }[] }>(
        await callRoute(GET, {
          url: "/api/media/stats/cross-tab",
          searchParams: { dimension1: "addedAt", dimension2: "videoCodec" },
        }),
        200,
      );
      expect(body.rows.map((r) => r.dim1)).toEqual(["2024-03"]);
    } finally {
      // `process.env.X = undefined` stores the string "undefined".
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("leaves out the types either dimension does not apply to", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    await createTestMediaItem(movies.id, { videoCodec: "h264", audioCodec: "aac" });
    const track = await createTestMediaItem(music.id, { type: "MUSIC", audioCodec: "flac" });
    await getTestPrisma().mediaItem.update({ where: { id: track.id }, data: { videoCodec: null } });

    // Video codec × audio codec: a track has no video codec (excludeTypes MUSIC).
    for (const [dimension1, dimension2] of [["videoCodec", "audioCodec"], ["resolution", "audioCodec"]]) {
      const body = await expectJson<{ rows: { type: string }[] }>(
        await callRoute(GET, { url: "/api/media/stats/cross-tab", searchParams: { dimension1, dimension2 } }),
        200,
      );
      expect(body.rows.map((r) => r.type), `${dimension1} x ${dimension2}`).toEqual(["MOVIE"]);
    }
  });
});
