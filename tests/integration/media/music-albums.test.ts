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
import { GET } from "@/app/api/media/music/albums/route";

describe("GET /api/media/music/albums", () => {
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
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Artist" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when parentTitle is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/music/albums" });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("parentTitle is required");
  });

  it("returns empty albums when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Artist" },
    });
    const body = await expectJson<{ albums: unknown[] }>(response, 200);
    expect(body.albums).toEqual([]);
  });

  it("returns empty albums when no tracks match parentTitle", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    await createTestMediaItem(lib.id, {
      title: "Track 1",
      type: "MUSIC",
      parentTitle: "Other Artist",
      albumTitle: "Album A",
      audioCodec: "flac",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Nonexistent" },
    });
    const body = await expectJson<{ albums: unknown[] }>(response, 200);
    expect(body.albums).toEqual([]);
  });

  it("groups tracks by album title and returns correct counts", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    await createTestMediaItem(lib.id, {
      title: "Song 1",
      type: "MUSIC",
      parentTitle: "Artist X",
      albumTitle: "Album One",
      audioCodec: "flac",
      fileSize: BigInt("10000000"),
    });
    await createTestMediaItem(lib.id, {
      title: "Song 2",
      type: "MUSIC",
      parentTitle: "Artist X",
      albumTitle: "Album One",
      audioCodec: "flac",
      fileSize: BigInt("20000000"),
    });
    await createTestMediaItem(lib.id, {
      title: "Song 3",
      type: "MUSIC",
      parentTitle: "Artist X",
      albumTitle: "Album Two",
      audioCodec: "mp3",
      fileSize: BigInt("5000000"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Artist X" },
    });
    const body = await expectJson<{
      albums: {
        albumTitle: string;
        trackCount: number;
        totalSize: string;
        audioCodecCounts: Record<string, number>;
      }[];
    }>(response, 200);

    expect(body.albums).toHaveLength(2);

    // Sorted alphabetically
    const albumOne = body.albums.find((a) => a.albumTitle === "Album One");
    expect(albumOne).toBeDefined();
    expect(albumOne!.trackCount).toBe(2);
    expect(albumOne!.totalSize).toBe("30000000");
    expect(albumOne!.audioCodecCounts["FLAC"]).toBe(2);

    const albumTwo = body.albums.find((a) => a.albumTitle === "Album Two");
    expect(albumTwo).toBeDefined();
    expect(albumTwo!.trackCount).toBe(1);
    expect(albumTwo!.totalSize).toBe("5000000");
    expect(albumTwo!.audioCodecCounts["MP3"]).toBe(1);
  });

  it("uses 'Unknown Album' for tracks without albumTitle", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    await createTestMediaItem(lib.id, {
      title: "Loose Track",
      type: "MUSIC",
      parentTitle: "Artist Y",
      audioCodec: "aac",
      fileSize: BigInt("8000000"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Artist Y" },
    });
    const body = await expectJson<{
      albums: { albumTitle: string; trackCount: number }[];
    }>(response, 200);

    expect(body.albums).toHaveLength(1);
    expect(body.albums[0].albumTitle).toBe("Unknown Album");
    expect(body.albums[0].trackCount).toBe(1);
  });

  it("serializes totalSize as string (BigInt)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    await createTestMediaItem(lib.id, {
      title: "Track",
      type: "MUSIC",
      parentTitle: "Artist Z",
      albumTitle: "Big Album",
      audioCodec: "flac",
      fileSize: BigInt("10737418240"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/music/albums",
      searchParams: { parentTitle: "Artist Z" },
    });
    const body = await expectJson<{
      albums: { totalSize: string }[];
    }>(response, 200);

    expect(body.albums[0].totalSize).toBe("10737418240");
    expect(typeof body.albums[0].totalSize).toBe("string");
  });
});
