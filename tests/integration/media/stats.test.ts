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

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/stats/route";

describe("GET /api/media/stats", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns zeroed stats when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      movieCount: number;
      seriesCount: number;
      musicCount: number;
      episodeCount: number;
      totalSize: string;
      qualityBreakdown: unknown[];
      topMovies: unknown[];
      topSeries: unknown[];
    }>(response, 200);

    expect(body.movieCount).toBe(0);
    expect(body.seriesCount).toBe(0);
    expect(body.musicCount).toBe(0);
    expect(body.episodeCount).toBe(0);
    expect(body.totalSize).toBe("0");
    expect(body.qualityBreakdown).toEqual([]);
    expect(body.topMovies).toEqual([]);
    expect(body.topSeries).toEqual([]);
  });

  it("returns correct counts for movies, series, and music", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });
    const musicLib = await createTestLibrary(server.id, { type: "MUSIC" });

    // 2 movies
    await createTestMediaItem(movieLib.id, {
      title: "Movie 1",
      type: "MOVIE",
      fileSize: BigInt("1073741824"),
    });
    await createTestMediaItem(movieLib.id, {
      title: "Movie 2",
      type: "MOVIE",
      fileSize: BigInt("2147483648"),
    });

    // 3 episodes across 2 shows
    await createTestMediaItem(seriesLib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      fileSize: BigInt("536870912"),
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      fileSize: BigInt("536870912"),
      ratingKey: "ep2",
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Show B",
      seasonNumber: 1,
      fileSize: BigInt("536870912"),
      ratingKey: "ep3",
    });

    // 1 music track
    await createTestMediaItem(musicLib.id, {
      title: "Track 1",
      type: "MUSIC",
      parentTitle: "Artist",
      audioCodec: "flac",
      fileSize: BigInt("52428800"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      movieCount: number;
      seriesCount: number;
      episodeCount: number;
      musicCount: number;
      totalSize: string;
    }>(response, 200);

    expect(body.movieCount).toBe(2);
    expect(body.seriesCount).toBe(2); // 2 distinct shows
    expect(body.episodeCount).toBe(3);
    expect(body.musicCount).toBe(1);
    // Total = 1GB + 2GB + 512MB*3 + 50MB
    expect(BigInt(body.totalSize)).toBe(
      BigInt("1073741824") +
        BigInt("2147483648") +
        BigInt("536870912") * BigInt(3) +
        BigInt("52428800")
    );
  });

  it("serializes totalSize as string (BigInt)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Movie",
      type: "MOVIE",
      fileSize: BigInt("10737418240"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{ totalSize: string }>(response, 200);

    expect(body.totalSize).toBe("10737418240");
    expect(typeof body.totalSize).toBe("string");
  });

  it("returns quality breakdown grouped by resolution and type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Movie 4K",
      type: "MOVIE",
      resolution: "4k",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 1080p",
      type: "MOVIE",
      resolution: "1080p",
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 1080p 2",
      type: "MOVIE",
      resolution: "1080p",
      ratingKey: "m1080p2",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      qualityBreakdown: {
        resolution: string;
        type: string;
        _count: number;
      }[];
    }>(response, 200);

    expect(body.qualityBreakdown).toHaveLength(2);

    const q4k = body.qualityBreakdown.find((q) => q.resolution === "4k");
    expect(q4k?._count).toBe(1);

    const q1080 = body.qualityBreakdown.find((q) => q.resolution === "1080p");
    expect(q1080?._count).toBe(2);
  });

  it("returns top movies by play count", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Popular Movie",
      type: "MOVIE",
      playCount: 10,
    });
    await createTestMediaItem(lib.id, {
      title: "Unwatched Movie",
      type: "MOVIE",
      playCount: 0,
    });
    await createTestMediaItem(lib.id, {
      title: "Somewhat Popular",
      type: "MOVIE",
      playCount: 5,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      topMovies: { title: string; playCount: number }[];
    }>(response, 200);

    // Only movies with playCount > 0
    expect(body.topMovies).toHaveLength(2);
    expect(body.topMovies[0].title).toBe("Popular Movie");
    expect(body.topMovies[0].playCount).toBe(10);
    expect(body.topMovies[1].title).toBe("Somewhat Popular");
  });

  it("returns top series by total play count", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Show A: total plays = 15
    await createTestMediaItem(lib.id, {
      title: "A-Ep1",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      playCount: 10,
    });
    await createTestMediaItem(lib.id, {
      title: "A-Ep2",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      playCount: 5,
      ratingKey: "a-ep2",
    });

    // Show B: total plays = 3
    await createTestMediaItem(lib.id, {
      title: "B-Ep1",
      type: "SERIES",
      parentTitle: "Show B",
      seasonNumber: 1,
      playCount: 3,
      ratingKey: "b-ep1",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      topSeries: { parentTitle: string; totalPlays: number }[];
    }>(response, 200);

    expect(body.topSeries).toHaveLength(2);
    expect(body.topSeries[0].parentTitle).toBe("Show A");
    expect(body.topSeries[0].totalPlays).toBe(15);
    expect(body.topSeries[1].parentTitle).toBe("Show B");
    expect(body.topSeries[1].totalPlays).toBe(3);
  });

  it("returns genre breakdown from raw SQL", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

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

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      genreBreakdown: { value: string; type: string; _count: number }[];
    }>(response, 200);

    expect(body.genreBreakdown.length).toBeGreaterThan(0);

    const action = body.genreBreakdown.find((g) => g.value === "Action");
    expect(action).toBeDefined();
    expect(action!._count).toBe(2);

    const scifi = body.genreBreakdown.find((g) => g.value === "Sci-Fi");
    expect(scifi).toBeDefined();
    expect(scifi!._count).toBe(1);
  });

  it("filters stats by serverId", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server1" });
    const server2 = await createTestServer(user.id, { name: "Server2" });
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, {
      title: "S1 Movie",
      type: "MOVIE",
      fileSize: BigInt("1073741824"),
    });
    await createTestMediaItem(lib2.id, {
      title: "S2 Movie",
      type: "MOVIE",
      fileSize: BigInt("2147483648"),
      ratingKey: "s2m1",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats",
      searchParams: { serverId: server1.id },
    });
    const body = await expectJson<{
      movieCount: number;
      totalSize: string;
    }>(response, 200);

    expect(body.movieCount).toBe(1);
    expect(body.totalSize).toBe("1073741824");
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats",
      searchParams: { serverId: server.id },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });
});
