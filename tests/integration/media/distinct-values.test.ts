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
import { GET } from "@/app/api/media/distinct-values/route";

describe("GET /api/media/distinct-values", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    await expectJson<{ error: string }>(response, 401);
  });

  it("returns data with authenticated session", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{
      resolution: string[];
      videoCodec: string[];
    }>(response, 200);

    expect(body.resolution).toEqual([]);
    expect(body.videoCodec).toEqual([]);
  });

  it("returns distinct resolution values normalized to standard labels", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "4K Movie",
      type: "MOVIE",
      resolution: "4k",
    });
    await createTestMediaItem(lib.id, {
      title: "1080p Movie",
      type: "MOVIE",
      resolution: "1080p",
    });
    await createTestMediaItem(lib.id, {
      title: "720p Movie",
      type: "MOVIE",
      resolution: "720p",
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ resolution: string[] }>(response, 200);

    // Normalized to standard labels like 4K, 1080P, 720P
    expect(body.resolution).toContain("4K");
    expect(body.resolution).toContain("1080P");
    expect(body.resolution).toContain("720P");
  });

  it("returns distinct video codecs sorted alphabetically", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "H264 Movie",
      type: "MOVIE",
      videoCodec: "h264",
    });
    await createTestMediaItem(lib.id, {
      title: "HEVC Movie",
      type: "MOVIE",
      videoCodec: "hevc",
    });
    await createTestMediaItem(lib.id, {
      title: "AV1 Movie",
      type: "MOVIE",
      videoCodec: "av1",
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ videoCodec: string[] }>(response, 200);

    expect(body.videoCodec).toEqual(["av1", "h264", "hevc"]);
  });

  it("returns distinct audio codecs sorted alphabetically", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "AAC Movie",
      type: "MOVIE",
      audioCodec: "aac",
    });
    await createTestMediaItem(lib.id, {
      title: "DTS Movie",
      type: "MOVIE",
      audioCodec: "dts",
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ audioCodec: string[] }>(response, 200);

    expect(body.audioCodec).toEqual(["aac", "dts"]);
  });

  it("returns distinct containers sorted alphabetically", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "MKV Movie",
      type: "MOVIE",
      container: "mkv",
    });
    await createTestMediaItem(lib.id, {
      title: "MP4 Movie",
      type: "MOVIE",
      container: "mp4",
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ container: string[] }>(response, 200);

    expect(body.container).toEqual(["mkv", "mp4"]);
  });

  it("returns distinct dynamic range values sorted by rank", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "SDR Movie",
      type: "MOVIE",
      dynamicRange: "SDR",
    });
    await createTestMediaItem(lib.id, {
      title: "HDR10 Movie",
      type: "MOVIE",
      dynamicRange: "HDR10",
    });
    await createTestMediaItem(lib.id, {
      title: "DV Movie",
      type: "MOVIE",
      dynamicRange: "Dolby Vision",
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ dynamicRange: string[] }>(response, 200);

    // Sorted by rank descending: Dolby Vision > HDR10 > SDR
    expect(body.dynamicRange[0]).toBe("Dolby Vision");
    expect(body.dynamicRange[1]).toBe("HDR10");
    expect(body.dynamicRange[2]).toBe("SDR");
  });

  it("returns distinct genres from JSONB arrays deduplicated", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Movie 1",
      type: "MOVIE",
      genres: ["Action", "Sci-Fi"],
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 2",
      type: "MOVIE",
      genres: ["Action", "Comedy"],
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ genre: string[] }>(response, 200);

    expect(body.genre).toContain("Action");
    expect(body.genre).toContain("Sci-Fi");
    expect(body.genre).toContain("Comedy");
    // No duplicates
    const actionCount = body.genre.filter((g: string) => g === "Action").length;
    expect(actionCount).toBe(1);
  });

  it("returns file size min/max as strings (BigInt)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Small",
      type: "MOVIE",
      fileSize: BigInt("104857600"), // 100MB
    });
    await createTestMediaItem(lib.id, {
      title: "Big",
      type: "MOVIE",
      fileSize: BigInt("10737418240"), // 10GB
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{
      fileSizeMin: string;
      fileSizeMax: string;
    }>(response, 200);

    expect(body.fileSizeMin).toBe("104857600");
    expect(body.fileSizeMax).toBe("10737418240");
    expect(typeof body.fileSizeMin).toBe("string");
    expect(typeof body.fileSizeMax).toBe("string");
  });

  it("returns year values sorted descending", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Old Movie",
      type: "MOVIE",
      year: 1990,
    });
    await createTestMediaItem(lib.id, {
      title: "New Movie",
      type: "MOVIE",
      year: 2024,
    });
    await createTestMediaItem(lib.id, {
      title: "Mid Movie",
      type: "MOVIE",
      year: 2010,
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{ year: number[] }>(response, 200);

    expect(body.year).toEqual([2024, 2010, 1990]);
  });

  it("returns null for size ranges when no items exist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{
      fileSizeMin: string | null;
      fileSizeMax: string | null;
      durationMin: number | null;
      durationMax: number | null;
    }>(response, 200);

    expect(body.fileSizeMin).toBeNull();
    expect(body.fileSizeMax).toBeNull();
    expect(body.durationMin).toBeNull();
    expect(body.durationMax).toBeNull();
  });

  it("returns play count and rating ranges", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Movie 1",
      type: "MOVIE",
      playCount: 0,
    });
    await createTestMediaItem(lib.id, {
      title: "Movie 2",
      type: "MOVIE",
      playCount: 25,
    });

    const response = await callRoute(GET, {
      url: "/api/media/distinct-values",
    });
    const body = await expectJson<{
      playCountMin: number;
      playCountMax: number;
    }>(response, 200);

    expect(body.playCountMin).toBe(0);
    expect(body.playCountMax).toBe(25);
  });
});
