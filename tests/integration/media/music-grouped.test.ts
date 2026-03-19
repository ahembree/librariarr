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
import { GET } from "@/app/api/media/music/grouped/route";

describe("GET /api/media/music/grouped", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ─── Auth ───

  describe("authentication", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });
  });

  // ─── Empty state ───

  describe("empty state", () => {
    it("returns empty artists with no data, includes pagination", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: unknown[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.artists).toEqual([]);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  // ─── Grouping ───

  describe("grouping", () => {
    it("groups tracks by artist (parentTitle) with correct counts", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Queen: 2 tracks across 2 albums
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

      const response = await callRoute(GET, {
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
      // 50MB + 10MB = 62914560
      expect(queen!.totalSize).toBe("62914560");
      expect(queen!.audioCodecCounts["FLAC"]).toBe(1);
      expect(queen!.audioCodecCounts["MP3"]).toBe(1);

      const pf = body.artists.find((a) => a.parentTitle === "Pink Floyd");
      expect(pf).toBeDefined();
      expect(pf!.trackCount).toBe(1);
      expect(pf!.albumCount).toBe(1);
    });

    it("does not include MOVIE or SERIES items in music grouping", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const musicLib = await createTestLibrary(server.id, { type: "MUSIC" });
      const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
      const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(musicLib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });
      await createTestMediaItem(movieLib.id, {
        title: "The Matrix",
        type: "MOVIE",
      });
      await createTestMediaItem(seriesLib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].parentTitle).toBe("Adele");
    });

    it("serializes totalSize as string (BigInt)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "HiRes Track",
        type: "MUSIC",
        parentTitle: "Artist",
        audioCodec: "flac",
        fileSize: BigInt("5368709120"),
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { totalSize: string }[];
      }>(response, 200);

      expect(body.artists[0].totalSize).toBe("5368709120");
      expect(typeof body.artists[0].totalSize).toBe("string");
    });

    it("counts albums correctly when same album has multiple tracks", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // 3 tracks from same album = 1 album count
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        albumTitle: "21",
        audioCodec: "flac",
        ratingKey: "rk-1",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 2",
        type: "MUSIC",
        parentTitle: "Adele",
        albumTitle: "21",
        audioCodec: "flac",
        ratingKey: "rk-2",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 3",
        type: "MUSIC",
        parentTitle: "Adele",
        albumTitle: "25",
        audioCodec: "flac",
        ratingKey: "rk-3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { parentTitle: string; trackCount: number; albumCount: number }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].trackCount).toBe(3);
      expect(body.artists[0].albumCount).toBe(2); // "21" and "25"
    });

    it("does not return artists from other users' servers", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server1 = await createTestServer(user1.id);
      const server2 = await createTestServer(user2.id);
      const lib1 = await createTestLibrary(server1.id, { type: "MUSIC" });
      const lib2 = await createTestLibrary(server2.id, { type: "MUSIC" });

      await createTestMediaItem(lib1.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "User1 Artist",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib2.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "User2 Artist",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].parentTitle).toBe("User1 Artist");
    });
  });

  // ─── Pagination ───

  describe("pagination", () => {
    it("paginates grouped artists correctly", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Create 5 different artists
      const artistNames = ["Adele", "Beatles", "Coldplay", "Drake", "Eminem"];
      for (const name of artistNames) {
        await createTestMediaItem(lib.id, {
          title: "Track 1",
          type: "MUSIC",
          parentTitle: name,
          audioCodec: "flac",
          ratingKey: `rk-${name}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Page 1, limit 2
      const response1 = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { page: "1", limit: "2" },
      });
      const body1 = await expectJson<{
        artists: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response1, 200);

      expect(body1.artists).toHaveLength(2);
      expect(body1.pagination.page).toBe(1);
      expect(body1.pagination.limit).toBe(2);
      expect(body1.pagination.hasMore).toBe(true);

      // Page 2, limit 2
      const response2 = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { page: "2", limit: "2" },
      });
      const body2 = await expectJson<{
        artists: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response2, 200);

      expect(body2.artists).toHaveLength(2);
      expect(body2.pagination.page).toBe(2);
      expect(body2.pagination.hasMore).toBe(true);

      // Page 3, limit 2 (last page)
      const response3 = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { page: "3", limit: "2" },
      });
      const body3 = await expectJson<{
        artists: { parentTitle: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response3, 200);

      expect(body3.artists).toHaveLength(1);
      expect(body3.pagination.hasMore).toBe(false);
    });

    it("caps limit at 200", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track",
        type: "MUSIC",
        parentTitle: "Artist",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { limit: "999" },
      });
      const body = await expectJson<{
        pagination: { limit: number };
      }>(response, 200);

      expect(body.pagination.limit).toBe(200);
    });

    it("returns all items when limit=0", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      for (let i = 1; i <= 5; i++) {
        await createTestMediaItem(lib.id, {
          title: `Track 1`,
          type: "MUSIC",
          parentTitle: `Artist ${String(i).padStart(2, "0")}`,
          audioCodec: "flac",
          ratingKey: `rk-${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { limit: "0" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
        pagination: { limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.artists).toHaveLength(5);
      expect(body.pagination.limit).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  // ─── Filtering ───

  describe("filtering", () => {
    it("filters by startsWith letter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "rk-adele",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "mp3",
        ratingKey: "rk-beatles",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beyonce",
        audioCodec: "flac",
        ratingKey: "rk-beyonce",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { startsWith: "B" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(2);
      const titles = body.artists.map((a) => a.parentTitle).sort();
      expect(titles).toEqual(["Beatles", "Beyonce"]);
    });

    it("filters by startsWith # for non-alphabetic artist names", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "2Pac",
        audioCodec: "mp3",
        ratingKey: "rk-2pac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "50 Cent",
        audioCodec: "mp3",
        ratingKey: "rk-50cent",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "rk-adele",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { startsWith: "#" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(2);
      const titles = body.artists.map((a) => a.parentTitle).sort();
      expect(titles).toEqual(["2Pac", "50 Cent"]);
    });

    it("filters by search parameter (case-insensitive parentTitle match)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Queen",
        audioCodec: "flac",
        ratingKey: "rk-queen",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Pink Floyd",
        audioCodec: "flac",
        ratingKey: "rk-pf",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { search: "queen" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].parentTitle).toBe("Queen");
    });

    it("combines startsWith and search filters", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "flac",
        ratingKey: "rk-beatles",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beyonce",
        audioCodec: "mp3",
        ratingKey: "rk-beyonce",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "rk-adele",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { startsWith: "B", search: "beatles" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists).toHaveLength(1);
      expect(body.artists[0].parentTitle).toBe("Beatles");
    });
  });

  // ─── Sorting ───

  describe("sorting", () => {
    it("sorts by parentTitle ascending by default", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Coldplay",
        audioCodec: "mp3",
        ratingKey: "rk-c",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "rk-a",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "flac",
        ratingKey: "rk-b",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists.map((a) => a.parentTitle)).toEqual([
        "Adele",
        "Beatles",
        "Coldplay",
      ]);
    });

    it("sorts by parentTitle descending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "rk-a",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "flac",
        ratingKey: "rk-b",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { sortBy: "parentTitle", sortOrder: "desc" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string }[];
      }>(response, 200);

      expect(body.artists.map((a) => a.parentTitle)).toEqual([
        "Beatles",
        "Adele",
      ]);
    });

    it("sorts by trackCount descending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Artist A: 1 track
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Artist A",
        audioCodec: "mp3",
        ratingKey: "rk-a1",
      });

      // Artist B: 3 tracks
      for (let i = 1; i <= 3; i++) {
        await createTestMediaItem(lib.id, {
          title: `Track ${i}`,
          type: "MUSIC",
          parentTitle: "Artist B",
          audioCodec: "flac",
          ratingKey: `rk-b${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { sortBy: "trackCount", sortOrder: "desc" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string; trackCount: number }[];
      }>(response, 200);

      expect(body.artists[0].parentTitle).toBe("Artist B");
      expect(body.artists[0].trackCount).toBe(3);
      expect(body.artists[1].parentTitle).toBe("Artist A");
      expect(body.artists[1].trackCount).toBe(1);
    });

    it("sorts by albumCount ascending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      // Artist A: 3 tracks across 3 albums
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Artist A",
        albumTitle: "Album 1",
        audioCodec: "flac",
        ratingKey: "rk-a1",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 2",
        type: "MUSIC",
        parentTitle: "Artist A",
        albumTitle: "Album 2",
        audioCodec: "flac",
        ratingKey: "rk-a2",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 3",
        type: "MUSIC",
        parentTitle: "Artist A",
        albumTitle: "Album 3",
        audioCodec: "flac",
        ratingKey: "rk-a3",
      });

      // Artist B: 1 track, 1 album
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Artist B",
        albumTitle: "Only Album",
        audioCodec: "mp3",
        ratingKey: "rk-b1",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { sortBy: "albumCount", sortOrder: "asc" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string; albumCount: number }[];
      }>(response, 200);

      expect(body.artists[0].parentTitle).toBe("Artist B");
      expect(body.artists[0].albumCount).toBe(1);
      expect(body.artists[1].parentTitle).toBe("Artist A");
      expect(body.artists[1].albumCount).toBe(3);
    });

    it("sorts by totalSize ascending", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Big Artist",
        audioCodec: "flac",
        fileSize: BigInt("10737418240"),
        ratingKey: "rk-big",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Small Artist",
        audioCodec: "mp3",
        fileSize: BigInt("5242880"),
        ratingKey: "rk-small",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
        searchParams: { sortBy: "totalSize", sortOrder: "asc" },
      });
      const body = await expectJson<{
        artists: { parentTitle: string; totalSize: string }[];
      }>(response, 200);

      expect(body.artists[0].parentTitle).toBe("Small Artist");
      expect(body.artists[1].parentTitle).toBe("Big Artist");
    });
  });

  // ─── Audio codec counts ───

  describe("audio codec counts", () => {
    it("includes audio codec counts per artist group", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Mixed Codec Artist",
        audioCodec: "flac",
        ratingKey: "rk-1",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 2",
        type: "MUSIC",
        parentTitle: "Mixed Codec Artist",
        audioCodec: "mp3",
        ratingKey: "rk-2",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 3",
        type: "MUSIC",
        parentTitle: "Mixed Codec Artist",
        audioCodec: "flac",
        ratingKey: "rk-3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: {
          parentTitle: string;
          audioCodecCounts: Record<string, number>;
        }[];
      }>(response, 200);

      const artist = body.artists[0];
      expect(artist.audioCodecCounts["FLAC"]).toBe(2);
      expect(artist.audioCodecCounts["MP3"]).toBe(1);
    });
  });

  // ─── Server info ───

  describe("server info", () => {
    it("includes server presence for each artist group", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "Home Plex" });
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, {
        url: "/api/media/music/grouped",
      });
      const body = await expectJson<{
        artists: {
          parentTitle: string;
          servers: { serverId: string; serverName: string }[];
        }[];
      }>(response, 200);

      expect(body.artists[0].servers).toHaveLength(1);
      expect(body.artists[0].servers[0].serverName).toBe("Home Plex");
    });
  });
});
