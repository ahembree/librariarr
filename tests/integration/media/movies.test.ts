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
import { GET } from "@/app/api/media/movies/route";

describe("GET /api/media/movies", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty items when user has no media", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{
      items: unknown[];
      pagination: { page: number; hasMore: boolean };
    }>(response, 200);

    expect(body.items).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
  });

  it("returns only MOVIE type items", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, {
      title: "Movies",
      type: "MOVIE",
    });
    const seriesLib = await createTestLibrary(server.id, {
      title: "TV",
      type: "SERIES",
    });

    await createTestMediaItem(movieLib.id, {
      title: "The Matrix",
      type: "MOVIE",
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Breaking Bad S01E01",
      type: "SERIES",
      parentTitle: "Breaking Bad",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{
      items: { title: string; type: string }[];
      pagination: { hasMore: boolean };
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("The Matrix");
    expect(body.pagination.hasMore).toBe(false);
  });

  it("serializes BigInt fileSize to string", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Big File Movie",
      type: "MOVIE",
      fileSize: BigInt("5368709120"), // 5 GB
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{
      items: { title: string; fileSize: string }[];
    }>(response, 200);

    expect(body.items[0].fileSize).toBe("5368709120");
    expect(typeof body.items[0].fileSize).toBe("string");
  });

  it("supports pagination", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    // Create 5 movies
    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(lib.id, {
        title: `Movie ${String(i).padStart(2, "0")}`,
        type: "MOVIE",
        ratingKey: `rk-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { page: "2", limit: "2" },
    });
    const body = await expectJson<{
      items: { title: string }[];
      pagination: { page: number; limit: number; hasMore: boolean };
    }>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.hasMore).toBe(true); // 5 items, page 2 of limit 2 = more pages
  });

  it("supports search by title", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "The Matrix", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Inception", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "The Dark Knight", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { search: "matrix" },
    });
    const body = await expectJson<{
      items: { title: string }[];
      pagination: { hasMore: boolean };
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("The Matrix");
  });

  it("supports sorting by title descending", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "Alpha", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Charlie", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Bravo", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { sortBy: "title", sortOrder: "desc" },
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items.map((i) => i.title)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
  });

  it("caps limit at 100", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "Test", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { limit: "999" },
    });
    const body = await expectJson<{
      pagination: { limit: number };
    }>(response, 200);

    expect(body.pagination.limit).toBe(100);
  });

  it("does not return movies from other users' servers", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, { title: "User1 Movie", type: "MOVIE" });
    await createTestMediaItem(lib2.id, { title: "User2 Movie", type: "MOVIE" });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("User1 Movie");
  });

  it("includes library and server info in response", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Home Plex" });
    const lib = await createTestLibrary(server.id, { title: "4K Movies" });

    await createTestMediaItem(lib.id, { title: "Test Film", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/media/movies" });
    const body = await expectJson<{
      items: {
        title: string;
        library: { title: string; mediaServer: { name: string } };
      }[];
    }>(response, 200);

    expect(body.items[0].library.title).toBe("4K Movies");
    expect(body.items[0].library.mediaServer.name).toBe("Home Plex");
  });

  it("filters by startsWith letter (case-insensitive)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "Alpha", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "avatar", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Bravo", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "300", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { startsWith: "A" },
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.title).sort()).toEqual(["Alpha", "avatar"]);
  });

  it("filters by startsWith # for non-alphabetic titles", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "12 Monkeys", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "300", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Alpha", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { startsWith: "#" },
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.title).sort()).toEqual(["12 Monkeys", "300"]);
  });

  it("combines startsWith with search filter", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, { title: "Alpha One", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Alpha Two", type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Beta One", type: "MOVIE" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/movies",
      searchParams: { startsWith: "A", search: "one" },
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Alpha One");
  });

  describe("pagination", () => {
    beforeEach(async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id);

      // Create 5 movies with deterministic ordering
      for (let i = 1; i <= 5; i++) {
        await createTestMediaItem(lib.id, {
          title: `Movie ${String(i).padStart(2, "0")}`,
          type: "MOVIE",
          ratingKey: `rk-pg-${i}`,
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    });

    it("returns paginated results with page and limit", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { page: "1", limit: "2" },
      });
      const body = await expectJson<{
        items: { title: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(2);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(2);
      expect(body.pagination.hasMore).toBe(true);
    });

    it("returns second page", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { page: "2", limit: "2" },
      });
      const body = await expectJson<{
        items: { title: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(2);
      expect(body.pagination.page).toBe(2);
      expect(body.pagination.hasMore).toBe(true);
    });

    it("returns last page with hasMore false", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { page: "3", limit: "2" },
      });
      const body = await expectJson<{
        items: { title: string }[];
        pagination: { page: number; limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.pagination.page).toBe(3);
      expect(body.pagination.hasMore).toBe(false);
    });

    it("returns all items when limit=0", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { limit: "0" },
      });
      const body = await expectJson<{
        items: { title: string }[];
        pagination: { limit: number; hasMore: boolean };
      }>(response, 200);

      expect(body.items).toHaveLength(5);
      expect(body.pagination.limit).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  describe("startsWith filter", () => {
    beforeEach(async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id);

      await createTestMediaItem(lib.id, { title: "Alien", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Avatar", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "Batman", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "1917", type: "MOVIE" });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    });

    it("filters by letter", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { startsWith: "A" },
      });
      const body = await expectJson<{
        items: { title: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(2);
      expect(body.items.map((i) => i.title).sort()).toEqual([
        "Alien",
        "Avatar",
      ]);
    });

    it("filters by # for non-alphabetic", async () => {
      const response = await callRoute(GET, {
        url: "/api/media/movies",
        searchParams: { startsWith: "#" },
      });
      const body = await expectJson<{
        items: { title: string }[];
      }>(response, 200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("1917");
    });
  });
});
