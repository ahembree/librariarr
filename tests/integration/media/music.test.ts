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
import { GET as GET_GROUPED } from "@/app/api/media/music/grouped/route";

describe("Music endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { parentTitle: "Queen" },
      });
      const body = await expectJson<{
        items: { parentTitle: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].parentTitle).toBe("Queen");
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { albumTitle: "Album One" },
      });
      const body = await expectJson<{
        items: { albumTitle: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].albumTitle).toBe("Album One");
    });

    it("searches across title, parentTitle, and albumTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Bohemian Rhapsody",
        type: "MUSIC",
        parentTitle: "Queen",
        albumTitle: "Opera",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Something",
        type: "MUSIC",
        parentTitle: "Queen Bee",
        albumTitle: "Debut",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "Unrelated",
        type: "MUSIC",
        parentTitle: "Nobody",
        albumTitle: "Nothing",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music",
        searchParams: { search: "queen" },
      });
      const body = await expectJson<{
        items: { title: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(2);
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

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/media/music" });
      const body = await expectJson<{
        items: { fileSize: string }[];
      }>(response, 200);

      expect(body.items[0].fileSize).toBe("104857600");
      expect(typeof body.items[0].fileSize).toBe("string");
    });
  });

  // ----- GET /api/media/music/grouped -----

  describe("GET /api/media/music/grouped", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty artists list when no data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{ artists: unknown[] }>(response, 200);

      expect(body.artists).toEqual([]);
    });

    it("groups tracks by artist with correct counts", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Queen: 2 tracks, 2 albums
      await createTestMediaItem(lib.id, {
        title: "Bohemian Rhapsody",
        type: "MUSIC",
        parentTitle: "Queen",
        albumTitle: "A Night at the Opera",
        audioCodec: "flac",
        fileSize: BigInt("52428800"),
      });
      await createTestMediaItem(lib.id, {
        title: "We Will Rock You",
        type: "MUSIC",
        parentTitle: "Queen",
        albumTitle: "News of the World",
        audioCodec: "mp3",
        fileSize: BigInt("10485760"),
      });

      // Pink Floyd: 1 track
      await createTestMediaItem(lib.id, {
        title: "Comfortably Numb",
        type: "MUSIC",
        parentTitle: "Pink Floyd",
        albumTitle: "The Wall",
        audioCodec: "flac",
        fileSize: BigInt("73400320"),
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: {
          parentTitle: string;
          trackCount: number;
          albumCount: number;
          totalSize: string;
          audioCodecCounts: Record<string, number>;
        }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(2);

      const queen = body.artists.find((a) => a.parentTitle === "Queen");
      expect(queen).toBeDefined();
      expect(queen!.trackCount).toBe(2);
      expect(queen!.albumCount).toBe(2);
      expect(queen!.totalSize).toBe("62914560"); // 50MB + 10MB
      expect(queen!.audioCodecCounts["FLAC"]).toBe(1);
      expect(queen!.audioCodecCounts["MP3"]).toBe(1);

      const pf = body.artists.find((a) => a.parentTitle === "Pink Floyd");
      expect(pf).toBeDefined();
      expect(pf!.trackCount).toBe(1);
      expect(pf!.albumCount).toBe(1);
    });

    it("supports search by artist name", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track",
        type: "MUSIC",
        parentTitle: "Queen",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track",
        type: "MUSIC",
        parentTitle: "Pink Floyd",
        audioCodec: "flac",
        ratingKey: "pf-1",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
        searchParams: { search: "queen" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].parentTitle).toBe("Queen");
    });

    it("supports sorting by trackCount desc", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Artist A: 1 track
      await createTestMediaItem(lib.id, {
        title: "Track",
        type: "MUSIC",
        parentTitle: "Artist A",
        audioCodec: "mp3",
      });

      // Artist B: 3 tracks
      for (let i = 1; i <= 3; i++) {
        await createTestMediaItem(lib.id, {
          title: `Track ${i}`,
          type: "MUSIC",
          parentTitle: "Artist B",
          audioCodec: "flac",
          ratingKey: `ab-${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
        searchParams: { sortBy: "trackCount", sortOrder: "desc" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string; trackCount: number }[];
      }>(response, 200);

      expect(body.artists[0].parentTitle).toBe("Artist B");
      expect(body.artists[0].trackCount).toBe(3);
    });

    it("serializes totalSize as string (BigInt)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track",
        type: "MUSIC",
        parentTitle: "Artist",
        audioCodec: "flac",
        fileSize: BigInt("5368709120"),
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_GROUPED, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { totalSize: string }[];
      }>(response, 200);

      expect(body.artists[0].totalSize).toBe("5368709120");
      expect(typeof body.artists[0].totalSize).toBe("string");
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
        ratingKey: `rk-off-${i}`,
        summary: "Prose that would ride along on every row.",
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
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
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).not.toHaveProperty("summary");
    expect(body.items[0]).toHaveProperty("title");
  });
});
