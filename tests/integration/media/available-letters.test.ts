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

// Import route handlers AFTER mocks
import { GET as GET_MOVIE_LETTERS } from "@/app/api/media/movies/available-letters/route";
import { GET as GET_SERIES_LETTERS } from "@/app/api/media/series/grouped/available-letters/route";
import { GET as GET_MUSIC_LETTERS } from "@/app/api/media/music/grouped/available-letters/route";

describe("Available letters endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ─── GET /api/media/movies/available-letters ───

  describe("GET /api/media/movies/available-letters", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty letters with no data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual([]);
    });

    it("returns correct letters based on movie titles", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(lib.id, { title: "Alien", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Batman", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Casablanca", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A", "B", "C"]);
    });

    it("includes # for titles starting with numbers", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(lib.id, { title: "1917", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "300", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Alien", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      // "#" should sort before alphabetic letters
      expect(body.letters).toEqual(["#", "A"]);
    });

    it("deduplicates letters for movies with same first letter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(lib.id, { title: "Alien", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Avatar", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Avengers", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });

    it("does not include letters from other users' data", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server1 = await createTestServer(user1.id);
      const server2 = await createTestServer(user2.id);
      const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
      const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

      await createTestMediaItem(lib1.id, { title: "Alien", type: "MOVIE" });
      await createTestMediaItem(lib2.id, { title: "Batman", type: "MOVIE" });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
      expect(body.letters).not.toContain("B");
    });

    it("excludes SERIES and MUSIC items from movie letters", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
      const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(movieLib.id, { title: "Alien", type: "MOVIE" });
      await createTestMediaItem(seriesLib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
      expect(body.letters).not.toContain("B");
    });

    it("handles case insensitivity (lowercase title still maps to uppercase letter)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(lib.id, { title: "alien", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MOVIE_LETTERS, {
        url: "/api/media/movies/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });
  });

  // ─── GET /api/media/series/grouped/available-letters ───

  describe("GET /api/media/series/grouped/available-letters", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty letters with no data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual([]);
    });

    it("returns correct letters based on series parentTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Castle",
        seasonNumber: 1,
        episodeNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A", "B", "C"]);
    });

    it("includes # for series starting with numbers", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "24",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toContain("#");
      expect(body.letters).toContain("A");
      // "#" sorts before "A"
      expect(body.letters[0]).toBe("#");
    });

    it("deduplicates letters from multiple episodes of the same series", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      // Multiple episodes with same parentTitle should yield only one "A"
      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "Honor Thy Father",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
        episodeNumber: 2,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });

    it("filters by search parameter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "SERIES" });

      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Breaking Bad",
        seasonNumber: 1,
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
        searchParams: { search: "arrow" },
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
      expect(body.letters).not.toContain("B");
    });

    it("does not include letters from other users' series", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server1 = await createTestServer(user1.id);
      const server2 = await createTestServer(user2.id);
      const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
      const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

      await createTestMediaItem(lib1.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Arrow",
        seasonNumber: 1,
      });
      await createTestMediaItem(lib2.id, {
        title: "S01E01",
        type: "SERIES",
        parentTitle: "Battlestar Galactica",
        seasonNumber: 1,
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_SERIES_LETTERS, {
        url: "/api/media/series/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });
  });

  // ─── GET /api/media/music/grouped/available-letters ───

  describe("GET /api/media/music/grouped/available-letters", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty letters with no data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual([]);
    });

    it("returns correct letters based on artist parentTitle", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Coldplay",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A", "B", "C"]);
    });

    it("includes # for artists starting with numbers", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "2Pac",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "50 Cent",
        audioCodec: "mp3",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toContain("#");
      expect(body.letters).toContain("A");
      // "#" sorts before "A"
      expect(body.letters[0]).toBe("#");
    });

    it("deduplicates letters from multiple tracks by the same artist", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Hello",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Rolling in the Deep",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
        ratingKey: "adele-2",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });

    it("filters by search parameter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MUSIC" });

      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
        searchParams: { search: "adele" },
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
      expect(body.letters).not.toContain("B");
    });

    it("does not include letters from other users' music", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server1 = await createTestServer(user1.id);
      const server2 = await createTestServer(user2.id);
      const lib1 = await createTestLibrary(server1.id, { type: "MUSIC" });
      const lib2 = await createTestLibrary(server2.id, { type: "MUSIC" });

      await createTestMediaItem(lib1.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Adele",
        audioCodec: "flac",
      });
      await createTestMediaItem(lib2.id, {
        title: "Track 1",
        type: "MUSIC",
        parentTitle: "Beatles",
        audioCodec: "mp3",
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET_MUSIC_LETTERS, {
        url: "/api/media/music/grouped/available-letters",
      });
      const body = await expectJson<{ letters: string[] }>(response, 200);

      expect(body.letters).toEqual(["A"]);
    });
  });
});
