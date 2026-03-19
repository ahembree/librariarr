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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toEqual([]);
  });

  it("returns empty items when q is empty string", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "  ", type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toEqual([]);
  });

  it("returns 400 when type is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "test" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type");
  });

  it("returns 400 when type is invalid", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    // Should match both: one by parentTitle, one by title
    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Breaking", type: "SERIES" },
    });
    const body = await expectJson<{ items: { title: string }[] }>(response, 200);
    expect(body.items).toHaveLength(2);
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Breaking", type: "SERIES", seriesScope: "true" },
    });
    const body = await expectJson<{ items: { parentTitle: string | null }[] }>(response, 200);
    // Only "Breaking Bad" matches parentTitle; "Breaking Point" title match is ignored
    expect(body.items).toHaveLength(1);
    expect(body.items[0].parentTitle).toBe("Breaking Bad");
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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/search",
      searchParams: { q: "Secret", type: "MOVIE" },
    });
    const body = await expectJson<{ items: unknown[] }>(response, 200);
    expect(body.items).toHaveLength(0);
  });
});
