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
import { GET } from "@/app/api/query/distinct-values/route";

describe("GET /api/query/distinct-values", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/query/distinct-values",
    });
    await expectJson<{ error: string }>(response, 401);
  });

  it("returns empty arrays when no data exists", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/query/distinct-values",
    });
    const body = await expectJson<{
      resolution: string[];
      videoCodec: string[];
      audioCodec: string[];
      container: string[];
      year: number[];
      genre: string[];
    }>(response, 200);

    expect(body.resolution).toEqual([]);
    expect(body.videoCodec).toEqual([]);
    expect(body.audioCodec).toEqual([]);
    expect(body.container).toEqual([]);
    expect(body.year).toEqual([]);
    expect(body.genre).toEqual([]);
  });

  it("returns distinct values for media items", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Movie A",
      type: "MOVIE",
      videoCodec: "h264",
      audioCodec: "aac",
      container: "mkv",
      year: 2024,
    });
    await createTestMediaItem(lib.id, {
      title: "Movie B",
      type: "MOVIE",
      videoCodec: "hevc",
      audioCodec: "dts",
      container: "mp4",
      year: 2020,
    });

    const response = await callRoute(GET, {
      url: "/api/query/distinct-values",
    });
    const body = await expectJson<{
      videoCodec: string[];
      audioCodec: string[];
      container: string[];
      year: number[];
    }>(response, 200);

    expect(body.videoCodec).toEqual(["h264", "hevc"]);
    expect(body.audioCodec).toEqual(["aac", "dts"]);
    expect(body.container).toEqual(["mkv", "mp4"]);
    expect(body.year).toEqual([2024, 2020]); // sorted descending
  });

  it("returns distinct stream languages from MediaStream table", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    const item = await createTestMediaItem(lib.id, {
      title: "Multi-lang Movie",
      type: "MOVIE",
    });

    // Audio streams (streamType 2)
    await createTestMediaStream(item.id, {
      streamType: 2,
      codec: "aac",
      language: "English",
    });
    await createTestMediaStream(item.id, {
      streamType: 2,
      codec: "aac",
      language: "French",
    });
    // Subtitle stream (streamType 3)
    await createTestMediaStream(item.id, {
      streamType: 3,
      codec: "srt",
      language: "Spanish",
    });

    const response = await callRoute(GET, {
      url: "/api/query/distinct-values",
    });
    const body = await expectJson<{
      audioLanguage: string[];
      subtitleLanguage: string[];
    }>(response, 200);

    expect(body.audioLanguage).toContain("English");
    expect(body.audioLanguage).toContain("French");
    expect(body.subtitleLanguage).toContain("Spanish");
  });

  it("returns distinct genres from JSONB arrays", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Action Movie",
      type: "MOVIE",
      genres: ["Action", "Sci-Fi"],
    });
    await createTestMediaItem(lib.id, {
      title: "Comedy Movie",
      type: "MOVIE",
      genres: ["Comedy", "Action"],
    });

    const response = await callRoute(GET, {
      url: "/api/query/distinct-values",
    });
    const body = await expectJson<{ genre: string[] }>(response, 200);

    expect(body.genre).toContain("Action");
    expect(body.genre).toContain("Sci-Fi");
    expect(body.genre).toContain("Comedy");
    // No duplicates
    const actionCount = body.genre.filter((g: string) => g === "Action").length;
    expect(actionCount).toBe(1);
  });
});
