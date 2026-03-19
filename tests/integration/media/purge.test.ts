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

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { DELETE } from "@/app/api/media/purge/route";

describe("DELETE /api/media/purge", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 with missing type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("returns 400 with invalid type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("deletes items of specified type and returns count", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    // Create 3 movies and 2 series items
    await createTestMediaItem(movieLib.id, { title: "Movie 1", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 2", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 3", type: "MOVIE" });
    await createTestMediaItem(seriesLib.id, { title: "Series 1", type: "SERIES" });
    await createTestMediaItem(seriesLib.id, { title: "Series 2", type: "SERIES" });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ deleted: number }>(response, 200);
    expect(body.deleted).toBe(3);

    // Verify movies are deleted but series items remain
    const remainingMovies = await prisma.mediaItem.count({
      where: { library: { type: "MOVIE" } },
    });
    expect(remainingMovies).toBe(0);

    const remainingSeries = await prisma.mediaItem.count({
      where: { library: { type: "SERIES" } },
    });
    expect(remainingSeries).toBe(2);
  });

  it("does not affect other user's items", async () => {
    const prisma = getTestPrisma();
    const user1 = await createTestUser({ plexId: "user1" });
    const user2 = await createTestUser({ plexId: "user2" });

    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);

    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createTestMediaItem(lib1.id, { title: "User1 Movie", type: "MOVIE" });
    await createTestMediaItem(lib2.id, { title: "User2 Movie", type: "MOVIE" });

    setMockSession({ isLoggedIn: true, userId: user1.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ deleted: number }>(response, 200);
    expect(body.deleted).toBe(1);

    // User2's movie should still exist
    const user2Movies = await prisma.mediaItem.count({
      where: { libraryId: lib2.id },
    });
    expect(user2Movies).toBe(1);
  });
});
