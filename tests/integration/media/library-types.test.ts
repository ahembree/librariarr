import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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
import { GET } from "@/app/api/media/library-types/route";

describe("GET /api/media/library-types", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty types when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toEqual([]);
  });

  it("returns distinct enabled library types", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    await createTestLibrary(server.id, {
      title: "Movies",
      type: "MOVIE",
      enabled: true,
    });
    await createTestLibrary(server.id, {
      title: "TV Shows",
      type: "SERIES",
      enabled: true,
    });
    await createTestLibrary(server.id, {
      title: "Music",
      type: "MUSIC",
      enabled: true,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toHaveLength(3);
    expect(body.types).toContain("MOVIE");
    expect(body.types).toContain("SERIES");
    expect(body.types).toContain("MUSIC");
  });

  it("excludes disabled libraries", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    await createTestLibrary(server.id, {
      title: "Movies",
      type: "MOVIE",
      enabled: true,
    });
    await createTestLibrary(server.id, {
      title: "TV Shows",
      type: "SERIES",
      enabled: false,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toHaveLength(1);
    expect(body.types).toContain("MOVIE");
    expect(body.types).not.toContain("SERIES");
  });

  it("returns distinct types even with multiple libraries of same type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    await createTestLibrary(server.id, {
      title: "Movies HD",
      type: "MOVIE",
      enabled: true,
    });
    await createTestLibrary(server.id, {
      title: "Movies 4K",
      type: "MOVIE",
      enabled: true,
      key: "movie-4k",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toHaveLength(1);
    expect(body.types).toContain("MOVIE");
  });

  it("does not return types from other users' servers", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);

    await createTestLibrary(server1.id, {
      title: "Movies",
      type: "MOVIE",
      enabled: true,
    });
    await createTestLibrary(server2.id, {
      title: "Music",
      type: "MUSIC",
      enabled: true,
    });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toHaveLength(1);
    expect(body.types).toContain("MOVIE");
    expect(body.types).not.toContain("MUSIC");
  });

  it("aggregates types across multiple servers of the same user", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server1" });
    const server2 = await createTestServer(user.id, { name: "Server2" });

    await createTestLibrary(server1.id, {
      title: "Movies",
      type: "MOVIE",
      enabled: true,
    });
    await createTestLibrary(server2.id, {
      title: "TV Shows",
      type: "SERIES",
      enabled: true,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/library-types",
    });
    const body = await expectJson<{ types: string[] }>(response, 200);

    expect(body.types).toHaveLength(2);
    expect(body.types).toContain("MOVIE");
    expect(body.types).toContain("SERIES");
  });
});
