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

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/search/route";

describe("GET /api/media/search", () => {
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
      url: "/api/media/search",
      searchParams: { q: "test", type: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty items when q is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toEqual([]);
  });

  it("returns empty items when q is empty string", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "  ", type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toEqual([]);
  });

  it("returns 400 when type is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "test" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type");
  });

  it("returns 400 when type is invalid", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "test", type: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type");
  });

  it("searches movies by title (case insensitive)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    await createTestMediaItem(lib.id, {
      title: "The Matrix",
      type: "MOVIE",
      year: 1999,
    });
    await createTestMediaItem(lib.id, {
      title: "Inception",
      type: "MOVIE",
      year: 2010,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "matrix", type: "MOVIE" },
    });
    const body = await expectJson<{ items: { title: string }[] }>(response, 200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("The Matrix");
  });

  it("searches series by title and parentTitle without seriesScope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Breaking Point",
      type: "SERIES",
      parentTitle: "Some Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    // Should match both: one by parentTitle, one by title
    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Breaking", type: "SERIES" },
    });
    const body = await expectJson<{ items: { title: string }[] }>(response, 200);
    expect(body.items).toHaveLength(2);
  });

  it("returns each episode's season and episode numbers, so it can be named by show and SxxExx", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(lib.id, {
      title: "Pilot", type: "SERIES", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });
    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Pilot", type: "SERIES" },
    });
    const body = await expectJson<{
      items: { title: string; parentTitle: string | null; seasonNumber: number | null; episodeNumber: number | null }[];
    }>(response, 200);
    expect(body.items).toEqual([
      expect.objectContaining({ title: "Pilot", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1 }),
    ]);
  });

  it("searches series by parentTitle only with seriesScope=true", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Breaking Point",
      type: "SERIES",
      parentTitle: "Some Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Breaking", type: "SERIES", seriesScope: "true" },
    });
    const body = await expectJson<{ items: { title: string; parentTitle: string | null; scope: string; itemCount: number }[] }>(response, 200);
    // Only "Breaking Bad" matches parentTitle; "Breaking Point" title match is ignored
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Breaking Bad");
    expect(body.items[0].parentTitle).toBeNull();
    expect(body.items[0].scope).toBe("series");
    expect(body.items[0].itemCount).toBe(1);
  });

  it("deduplicates by parentTitle when seriesScope=true", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Two episodes from same series
    await createTestMediaItem(lib.id, {
      title: "Ep1",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Ep2",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Breaking", type: "SERIES", seriesScope: "true" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    // Deduplicated to 1 result
    expect(body.items).toHaveLength(1);
  });

  it("limits results to 10 for non-seriesScope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    // Create 12 movies with "Test" in the title
    for (let i = 0; i < 12; i++) {
      await createTestMediaItem(lib.id, {
        title: `Test Movie ${i}`,
        type: "MOVIE",
        ratingKey: `rk-${i}`,
      });
    }

    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Test", type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toHaveLength(10);
  });

  it("does not return items belonging to another user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server1 = await createTestServer(user1.id);
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });

    await createTestMediaItem(lib1.id, {
      title: "Secret Movie",
      type: "MOVIE",
    });

    setMockSession({ userId: user2.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Secret", type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toHaveLength(0);
  });

  // Scoped search used to group a fixed window of rows (100 episodes ordered
  // by the episode's own title, 200 tracks) in JS: a long show filled the
  // window, so another matching show never came back, and every count was the
  // number of rows that happened to land in it.
  it("returns every matching show with its real episode count when seriesScope=true", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        libraryId: lib.id, ratingKey: `st-${i}`, type: "SERIES" as const,
        title: `A Trek Episode ${String(i).padStart(3, "0")}`,
        parentTitle: "Star Trek", seriesKey: "tvdb:1", seasonNumber: 1, episodeNumber: i + 1,
      })),
    });
    await prisma.mediaItem.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        libraryId: lib.id, ratingKey: `sw-${i}`, type: "SERIES" as const,
        title: `Z Andor Episode ${i}`,
        parentTitle: "Star Wars: Andor", seriesKey: "tvdb:2", seasonNumber: 1, episodeNumber: i + 1,
      })),
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{ items: { title: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "star", type: "SERIES", seriesScope: "true" } }),
      200,
    );
    expect(body.items.map((i) => [i.title, i.itemCount])).toEqual([
      ["Star Trek", 120],
      ["Star Wars: Andor", 3],
    ]);
  });

  it("keeps two same-titled shows apart and counts a copy on another server once", async () => {
    const user = await createTestUser();
    const serverA = await createTestServer(user.id, { name: "A" });
    const serverB = await createTestServer(user.id, { name: "B" });
    const libA = await createTestLibrary(serverA.id, { type: "SERIES" });
    const libB = await createTestLibrary(serverB.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    // The Office (US) on both servers — the same two episodes — and The Office (UK).
    for (const libraryId of [libA.id, libB.id]) {
      await prisma.mediaItem.createMany({
        data: [1, 2].map((e) => ({
          libraryId, ratingKey: `us-${e}`, type: "SERIES" as const, title: `US ${e}`,
          parentTitle: "The Office", seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: e,
          dedupKey: `office-us-1-${e}`,
        })),
      });
    }
    await prisma.mediaItem.create({
      data: {
        libraryId: libA.id, ratingKey: "uk-1", type: "SERIES", title: "UK 1",
        parentTitle: "The Office", seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1,
      },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{ items: { title: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "office", type: "SERIES", seriesScope: "true" } }),
      200,
    );
    expect(body.items.map((i) => i.itemCount).sort()).toEqual([1, 2]);
    expect(body.items.every((i) => i.title === "The Office")).toBe(true);
  });

  it("returns every matching artist with its real track count when musicScope=true", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.createMany({
      data: Array.from({ length: 210 }, (_, i) => ({
        libraryId: lib.id, ratingKey: `b-${i}`, type: "MUSIC" as const, title: `Track ${i}`,
        parentTitle: "The Beatles", albumTitle: `Album ${i % 10}`,
      })),
    });
    await prisma.mediaItem.create({
      data: { libraryId: lib.id, ratingKey: "w-1", type: "MUSIC", title: "Baba O'Riley", parentTitle: "The Who", albumTitle: "Who's Next" },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{ items: { title: string; scope: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "the", type: "MUSIC", musicScope: "true" } }),
      200,
    );
    const artists = body.items.filter((i) => i.scope === "artist");
    expect(artists.map((a) => [a.title, a.itemCount])).toEqual([
      ["The Beatles", 210],
      ["The Who", 1],
    ]);
  });

  // `dedupKey` names a track by artist + title and an episode by show +
  // SxxExx, so on ONE server two different rows can share it: the same song
  // on a studio album and a compilation, or episodes with no numbers. Only a
  // copy on ANOTHER server is the same item.
  it("counts same-titled tracks on one server separately, and a copy on another server once", async () => {
    const user = await createTestUser();
    const serverA = await createTestServer(user.id, { name: "A" });
    const serverB = await createTestServer(user.id, { name: "B" });
    const libA = await createTestLibrary(serverA.id, { type: "MUSIC" });
    const libB = await createTestLibrary(serverB.id, { type: "MUSIC" });
    const track = (libraryId: string, ratingKey: string, albumTitle: string, title: string) => ({
      libraryId, ratingKey, type: "MUSIC" as const, title, parentTitle: "Queen", albumTitle,
      // As computeDedupKey writes it for a track: artist + title, no album.
      dedupKey: `music:queen:${title.toLowerCase()}`,
    });
    await getTestPrisma().mediaItem.createMany({
      data: [
        track(libA.id, "a1", "A Night at the Opera", "Bohemian Rhapsody"),
        track(libA.id, "a2", "Greatest Hits", "Bohemian Rhapsody"),
        track(libA.id, "a3", "Greatest Hits", "Killer Queen"),
        // Server B holds a copy of the compilation.
        track(libB.id, "b1", "Greatest Hits", "Bohemian Rhapsody"),
        track(libB.id, "b2", "Greatest Hits", "Killer Queen"),
      ],
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const artists = await expectJson<{ items: { title: string; scope: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "queen", type: "MUSIC", musicScope: "true" } }),
      200,
    );
    expect(artists.items.filter((i) => i.scope === "artist").map((a) => [a.title, a.itemCount])).toEqual([["Queen", 3]]);

    const albums = await expectJson<{ items: { title: string; scope: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "greatest", type: "MUSIC", musicScope: "true" } }),
      200,
    );
    expect(albums.items.map((a) => [a.title, a.itemCount])).toEqual([["Greatest Hits", 2]]);
  });

  it("counts a show's unnumbered episodes on one server separately", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    await getTestPrisma().mediaItem.createMany({
      data: [1, 2, 3].map((i) => ({
        libraryId: lib.id, ratingKey: `n-${i}`, type: "SERIES" as const, title: `Special ${i}`,
        parentTitle: "Night Show", seriesKey: "tvdb:5",
        // computeDedupKey reads a missing season/episode number as 0.
        dedupKey: "series:tvdb:5:s0e0",
      })),
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{ items: { title: string; itemCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/search", searchParams: { q: "night", type: "SERIES", seriesScope: "true" } }),
      200,
    );
    expect(body.items.map((i) => [i.title, i.itemCount])).toEqual([["Night Show", 3]]);
  });
});
