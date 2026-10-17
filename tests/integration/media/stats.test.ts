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
    setMockSession({ userId: user.id, isLoggedIn: true });

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

    setMockSession({ userId: user.id, isLoggedIn: true });

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

    setMockSession({ userId: user.id, isLoggedIn: true });

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

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      qualityBreakdown: {
        resolution: string;
        type: string;
        _count: number;
      }[];
    }>(response, 200);

    // Raw stored values, ordered by value then type.
    expect(body.qualityBreakdown).toEqual([
      { _count: 2, resolution: "1080p", type: "MOVIE" },
      { _count: 1, resolution: "4k", type: "MOVIE" },
    ]);
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

    setMockSession({ userId: user.id, isLoggedIn: true });

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

    setMockSession({ userId: user.id, isLoggedIn: true });

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

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/stats" });
    const body = await expectJson<{
      genreBreakdown: { value: string; type: string; _count: number }[];
    }>(response, 200);

    expect(body.genreBreakdown.map((g) => `${g.value}:${g.type}:${g._count}`).sort()).toEqual([
      "Action:MOVIE:2",
      "Comedy:MOVIE:1",
      "Sci-Fi:MOVIE:1",
    ]);
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

    setMockSession({ userId: user.id, isLoggedIn: true });

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

  it("returns 404 when serverId names no server", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/stats",
      searchParams: { serverId: "nonexistent" },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("counts and ranks two same-titled shows separately by seriesKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Two "The Office" shows with distinct seriesKeys and different play totals.
    await createTestMediaItem(lib.id, {
      title: "Downsize", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1, playCount: 2, ratingKey: "uk1",
    });
    await createTestMediaItem(lib.id, {
      title: "Pilot", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 1, playCount: 5, ratingKey: "us1",
    });
    await createTestMediaItem(lib.id, {
      title: "Diversity Day", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 2, playCount: 4, ratingKey: "us2",
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{
      seriesCount: number;
      seasonCount: number;
      topSeries: { parentTitle: string; totalPlays: number }[];
    }>(await callRoute(GET, { url: "/api/media/stats" }), 200);

    // Two distinct shows (not one blended "The Office"), each with a season 1.
    expect(body.seriesCount).toBe(2);
    expect(body.seasonCount).toBe(2);

    // Ranked separately: US show (9 plays) above UK show (2), not pooled to 11.
    expect(body.topSeries).toHaveLength(2);
    expect(body.topSeries.map((s) => s.parentTitle)).toEqual(["The Office", "The Office"]);
    expect(body.topSeries[0].totalPlays).toBe(9);
    expect(body.topSeries[1].totalPlays).toBe(2);
  });

  it("counts an artist and album spread across servers once", async () => {
    const user = await createTestUser();
    const serverA = await createTestServer(user.id, { name: "A" });
    const serverB = await createTestServer(user.id, { name: "B" });
    const libA = await createTestLibrary(serverA.id, { type: "MUSIC" });
    const libB = await createTestLibrary(serverB.id, { type: "MUSIC" });
    const prisma = getTestPrisma();

    // Radiohead: OK Computer only on A, Kid A only on B, and the two halves of
    // one album split across servers. Each server has its own rating keys.
    const tracks = [
      { lib: libA.id, album: "OK Computer", artistKey: "a-art", albumKey: "a-okc", title: "Airbag" },
      { lib: libB.id, album: "Kid A", artistKey: "b-art", albumKey: "b-kida", title: "Idioteque" },
      { lib: libA.id, album: "In Rainbows", artistKey: "a-art", albumKey: "a-ir", title: "Nude" },
      { lib: libB.id, album: "in rainbows ", artistKey: "b-art", albumKey: "b-ir", title: "Reckoner" },
    ];
    for (const t of tracks) {
      const item = await createTestMediaItem(t.lib, {
        type: "MUSIC", title: t.title, parentTitle: t.lib === libB.id ? "radiohead" : "Radiohead",
        albumTitle: t.album,
      });
      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { grandparentRatingKey: t.artistKey, parentRatingKey: t.albumKey, dedupCanonical: true },
      });
    }

    setMockSession({ userId: user.id, isLoggedIn: true });
    const body = await expectJson<{ artistCount: number; albumCount: number; musicCount: number }>(
      await callRoute(GET, { url: "/api/media/stats" }),
      200,
    );

    expect(body.musicCount).toBe(4);
    expect(body.artistCount).toBe(1);
    expect(body.albumCount).toBe(3);
  });

  describe("with dedup across two servers", () => {
    async function seedTwoServers() {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const serverA = await createTestServer(user.id, { name: "A" });
      const serverB = await createTestServer(user.id, { name: "B" });
      const moviesA = await createTestLibrary(serverA.id, { type: "MOVIE" });
      const moviesB = await createTestLibrary(serverB.id, { type: "MOVIE" });
      const showsA = await createTestLibrary(serverA.id, { type: "SERIES" });

      const movie = async (
        libraryId: string,
        title: string,
        canonical: boolean,
        data: Record<string, unknown>,
      ) => {
        const item = await createTestMediaItem(libraryId, { type: "MOVIE", title });
        // Set after creation: the factory fills a null codec with a default.
        await prisma.mediaItem.update({ where: { id: item.id }, data: { ...data, dedupCanonical: canonical } });
        return item;
      };
      // "Alien" on both servers (one dedupKey), canonical on A. "Heat" only on B.
      await movie(moviesA.id, "Alien", true, {
        dedupKey: "movie:tmdb:348",
        fileSize: BigInt(1000), duration: 100, resolution: "4K", videoCodec: "hevc", audioCodec: "truehd",
        contentRating: "R", dynamicRange: "HDR10", audioChannels: 8, genres: ["Horror", "Sci-Fi"],
      });
      await movie(moviesB.id, "Alien", false, {
        dedupKey: "movie:tmdb:348",
        fileSize: BigInt(400), duration: 100, resolution: "1080p", videoCodec: "h264", audioCodec: "aac",
        contentRating: "R", dynamicRange: "SDR", audioChannels: 2, genres: ["Horror", "Sci-Fi"],
      });
      await movie(moviesB.id, "Heat", true, {
        dedupKey: "movie:tmdb:949",
        fileSize: BigInt(700), duration: 170, resolution: "1080p", videoCodec: "h264", audioCodec: null,
        contentRating: null, dynamicRange: "SDR", audioChannels: 6, genres: ["Crime"],
      });
      const episode = await createTestMediaItem(showsA.id, {
        type: "SERIES", title: "Pilot", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
      });
      await prisma.mediaItem.update({
        where: { id: episode.id },
        data: {
          dedupCanonical: true, seriesKey: "tvdb:1", fileSize: BigInt(50), duration: 30, resolution: "720p",
          videoCodec: null, audioCodec: null, contentRating: null, dynamicRange: null, audioChannels: null, genres: [],
        },
      });
      return { user, serverA, serverB };
    }

    it("counts, sizes and breaks down the canonical copies only", async () => {
      const { user } = await seedTwoServers();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const body = await expectJson<Record<string, unknown>>(await callRoute(GET, { url: "/api/media/stats" }), 200);

      expect(body).toMatchObject({
        movieCount: 2,
        episodeCount: 1,
        musicCount: 0,
        seriesCount: 1,
        seasonCount: 1,
        totalSize: "1750",
        movieSize: "1700",
        seriesSize: "50",
        musicSize: "0",
        movieDuration: 270,
        seriesDuration: 30,
        musicDuration: 0,
      });
      // Every breakdown is ordered by value (nulls last), then type.
      expect(body.qualityBreakdown).toEqual([
        { _count: 1, resolution: "1080p", type: "MOVIE" },
        { _count: 1, resolution: "4K", type: "MOVIE" },
        { _count: 1, resolution: "720p", type: "SERIES" },
      ]);
      expect(body.videoCodecBreakdown).toEqual([
        { _count: 1, videoCodec: "h264", type: "MOVIE" },
        { _count: 1, videoCodec: "hevc", type: "MOVIE" },
        { _count: 1, videoCodec: null, type: "SERIES" },
      ]);
      expect(body.audioCodecBreakdown).toEqual([
        { _count: 1, audioCodec: "truehd", type: "MOVIE" },
        { _count: 1, audioCodec: null, type: "MOVIE" },
        { _count: 1, audioCodec: null, type: "SERIES" },
      ]);
      expect(body.contentRatingBreakdown).toEqual([
        { _count: 1, contentRating: "R", type: "MOVIE" },
        { _count: 1, contentRating: null, type: "MOVIE" },
        { _count: 1, contentRating: null, type: "SERIES" },
      ]);
      expect(body.dynamicRangeBreakdown).toEqual([
        { _count: 1, dynamicRange: "HDR10", type: "MOVIE" },
        { _count: 1, dynamicRange: "SDR", type: "MOVIE" },
        { _count: 1, dynamicRange: null, type: "SERIES" },
      ]);
      expect(body.audioChannelsBreakdown).toEqual([
        { _count: 1, audioChannels: 6, type: "MOVIE" },
        { _count: 1, audioChannels: 8, type: "MOVIE" },
        { _count: 1, audioChannels: null, type: "SERIES" },
      ]);
      expect(
        (body.genreBreakdown as { value: string; type: string; _count: number }[])
          .map((g) => `${g.value}:${g.type}:${g._count}`)
          .sort(),
      ).toEqual(["Crime:MOVIE:1", "Horror:MOVIE:1", "Sci-Fi:MOVIE:1"]);
    });

    it("counts every copy on one server's view", async () => {
      const { user, serverB } = await seedTwoServers();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const body = await expectJson<Record<string, unknown>>(
        await callRoute(GET, { url: `/api/media/stats?serverId=${serverB.id}` }),
        200,
      );

      // Server B alone: no dedup, so its non-canonical "Alien" counts.
      expect(body).toMatchObject({ movieCount: 2, totalSize: "1100", movieSize: "1100", movieDuration: 270 });
      expect(body.qualityBreakdown).toEqual([{ _count: 2, resolution: "1080p", type: "MOVIE" }]);
    });

    it("falls back to every copy's total size when no copy is canonical", async () => {
      const { user } = await seedTwoServers();
      await getTestPrisma().mediaItem.updateMany({ data: { dedupCanonical: false } });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const body = await expectJson<Record<string, unknown>>(await callRoute(GET, { url: "/api/media/stats" }), 200);

      expect(body).toMatchObject({ movieCount: 0, totalSize: "2150", movieSize: "0", qualityBreakdown: [] });
    });
  });
});
