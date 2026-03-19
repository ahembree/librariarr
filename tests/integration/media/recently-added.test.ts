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
import { GET } from "@/app/api/media/recently-added/route";

describe("GET /api/media/recently-added", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty items when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: unknown[];
      total: number;
    }>(response, 200);

    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns recently added items ordered by addedAt desc", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    const old = new Date("2024-01-01");
    const mid = new Date("2024-06-15");
    const recent = new Date("2024-12-25");

    await createTestMediaItem(lib.id, {
      title: "Old Movie",
      type: "MOVIE",
      addedAt: old,
    });
    await createTestMediaItem(lib.id, {
      title: "Mid Movie",
      type: "MOVIE",
      addedAt: mid,
    });
    await createTestMediaItem(lib.id, {
      title: "Recent Movie",
      type: "MOVIE",
      addedAt: recent,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { title: string; addedAt: string }[];
      total: number;
    }>(response, 200);

    expect(body.items[0].title).toBe("Recent Movie");
    expect(body.items[1].title).toBe("Mid Movie");
    expect(body.items[2].title).toBe("Old Movie");
    expect(body.total).toBe(3);
  });

  it("respects the limit parameter", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(lib.id, {
        title: `Movie ${i}`,
        type: "MOVIE",
        addedAt: new Date(`2024-0${i}-01`),
        ratingKey: `rk-ra-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { limit: "2" },
    });
    const body = await expectJson<{
      items: { title: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("caps limit at 50", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Test",
      type: "MOVIE",
      addedAt: new Date(),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { limit: "999" },
    });
    // Should not fail; response limit capped at 50 internally
    expect(response.status).toBe(200);
  });

  it("filters by type when specified", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(movieLib.id, {
      title: "Movie",
      type: "MOVIE",
      addedAt: new Date("2024-12-01"),
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Episode",
      type: "SERIES",
      parentTitle: "Show",
      addedAt: new Date("2024-12-02"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{
      items: { title: string; type: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Movie");
    expect(body.total).toBe(1);
  });

  it("serializes addedAt as ISO string", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    const addedAt = new Date("2024-06-15T10:30:00.000Z");
    await createTestMediaItem(lib.id, {
      title: "Movie",
      type: "MOVIE",
      addedAt,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { addedAt: string }[];
    }>(response, 200);

    expect(body.items[0].addedAt).toBe("2024-06-15T10:30:00.000Z");
    expect(typeof body.items[0].addedAt).toBe("string");
  });

  it("filters by serverId", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server1" });
    const server2 = await createTestServer(user.id, { name: "Server2" });
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, {
      title: "S1 Movie",
      type: "MOVIE",
      addedAt: new Date(),
    });
    await createTestMediaItem(lib2.id, {
      title: "S2 Movie",
      type: "MOVIE",
      addedAt: new Date(),
      ratingKey: "s2-m",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { serverId: server1.id },
    });
    const body = await expectJson<{
      items: { title: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("S1 Movie");
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { serverId: server.id },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("does not return items from other users' servers", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, {
      title: "User1 Movie",
      type: "MOVIE",
      addedAt: new Date(),
    });
    await createTestMediaItem(lib2.id, {
      title: "User2 Movie",
      type: "MOVIE",
      addedAt: new Date(),
      ratingKey: "u2-m",
    });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("User1 Movie");
  });
});
