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

// Import route handlers AFTER mocks
import { GET } from "@/app/api/media/music/route";

// File-level, so the second suite below still has its connection.
afterAll(async () => {
  await disconnectTestDb();
});

describe("Music endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  // ----- GET /api/media/music (tracks) -----

  describe("GET /api/media/music", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/media/music" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty items when no music data exists", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/music" });
      const body = await expectJson<{
        items: unknown[];
        pagination: { hasMore: boolean };
      }>(response, 200);

      expect(body.items).toEqual([]);
      expect(body.pagination.hasMore).toBe(false);
    });

    it("returns only MUSIC type items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const musicLib = await createTestLibrary(server.id, {
        title: "Music",
        type: "MUSIC",
      });
      const movieLib = await createTestLibrary(server.id, {
        title: "Movies",
        type: "MOVIE",
      });

      await createTestMediaItem(musicLib.id, {
        title: "Bohemian Rhapsody",
        type: "MUSIC",
        parentTitle: "Queen",
        albumTitle: "A Night at the Opera",
        audioCodec: "flac",
      });
      await createTestMediaItem(movieLib.id, {
        title: "Some Movie",
        type: "MOVIE",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/music" });
      const body = await expectJson<{
        items: { title: string; type: string }[];
        pagination: { hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("Bohemian Rhapsody");
      expect(body.pagination.hasMore).toBe(false);
    });

    it("filters by parentTitle (artist)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Queen",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 2",
        type: "MUSIC",
        parentTitle: "Pink Floyd",
        audioCodec: "flac",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { parentTitle: "Queen" },
      });
      const body = await expectJson<{
        items: { parentTitle: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ title: "Track 1", parentTitle: "Queen" });
    });

    it("filters by albumTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track A",
        type: "MUSIC",
        parentTitle: "Artist",
        albumTitle: "Album One",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "Track B",
        type: "MUSIC",
        parentTitle: "Artist",
        albumTitle: "Album Two",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { albumTitle: "Album One" },
      });
      const body = await expectJson<{
        items: { albumTitle: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ title: "Track A", albumTitle: "Album One" });
    });

    it("searches across title, parentTitle, and albumTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // One match through each searched field.
      await createTestMediaItem(lib.id, {
        title: "Bohemian Rhapsody",
        type: "MUSIC",
        parentTitle: "Queen",
        albumTitle: "A Night at the Opera",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Killer Queen",
        type: "MUSIC",
        parentTitle: "Some Cover Band",
        albumTitle: "Covers",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "No One Knows",
        type: "MUSIC",
        parentTitle: "QOTSA",
        albumTitle: "Songs for the Deaf (Queens Edition)",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "Unrelated",
        type: "MUSIC",
        parentTitle: "Nobody",
        albumTitle: "Nothing",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { search: "queen" },
      });
      const body = await expectJson<{
        items: { title: string }[];
      }>(response, 200);

      expect(body.items.map((i) => i.title).sort()).toEqual([
        "Bohemian Rhapsody",
        "Killer Queen",
        "No One Knows",
      ]);
    });

    it("serializes BigInt fileSize to string", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "HiRes Track",
        type: "MUSIC",
        parentTitle: "Artist",
        audioCodec: "flac",
        fileSize: BigInt("104857600"),
      });

      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/music" });
      const body = await expectJson<{
        items: { fileSize: string }[];
      }>(response, 200);

      expect(body.items[0].fileSize).toBe("104857600");
      expect(typeof body.items[0].fileSize).toBe("string");
    });
  });
});

describe("/api/media/music progressive loading", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(lib.id, {
        title: `Item ${String(i).padStart(2, "0")}`,
        type: "MUSIC",
        parentTitle: "Artist",
        albumTitle: "Album",
        episodeNumber: i,
        ratingKey: `rk-off-${i}`,
        summary: "Prose that would ride along on every row.",
      });
    }
    setMockSession({ userId: user.id, isLoggedIn: true });
  });

  it("returns everything after an offset when limit=0", async () => {
    const body = await expectJson<{ items: { title: string }[] }>(
      await callRoute(GET, { url: "/api/media/music", searchParams: { limit: "0", offset: "2", sortBy: "title" } }),
      200,
    );
    expect(body.items.map((i) => i.title)).toEqual(["Item 03", "Item 04", "Item 05"]);
  });

  it("stitches an offset fetch onto a first page with no gap or overlap", async () => {
    const first = await expectJson<{ items: { title: string }[] }>(
      await callRoute(GET, { url: "/api/media/music", searchParams: { page: "1", limit: "2", sortBy: "title" } }),
      200,
    );
    const rest = await expectJson<{ items: { title: string }[] }>(
      await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { limit: "0", offset: String(first.items.length), sortBy: "title" },
      }),
      200,
    );
    const stitched = [...first.items, ...rest.items].map((i) => i.title);
    expect(stitched).toEqual(["Item 01", "Item 02", "Item 03", "Item 04", "Item 05"]);
    expect(new Set(stitched).size).toBe(5);
  });

  it("omits summary — the popover fetches it for the one hovered track", async () => {
    const body = await expectJson<{ items: Record<string, unknown>[] }>(
      await callRoute(GET, { url: "/api/media/music", searchParams: { limit: "0" } }),
      200,
    );
    expect(body.items).toHaveLength(5);
    for (const item of body.items) expect(item).not.toHaveProperty("summary");
    expect(body.items[0]).toHaveProperty("title", "Item 01");
  });
});
