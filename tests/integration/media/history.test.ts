import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetWatchHistory = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getWatchHistory: mockGetWatchHistory,
    };
  }),
}));

import { GET } from "@/app/api/media/[id]/history/route";

describe("GET /api/media/[id]/history", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockGetWatchHistory.mockResolvedValue([]);
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id);
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRouteWithParams(GET, { id: "any" });
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
  });

  it("returns aggregated watch history", async () => {
    const item = await createTestMediaItem(libraryId);
    mockGetWatchHistory.mockResolvedValue([
      { username: "alice", watchedAt: "2024-06-01T00:00:00Z" },
      { username: "alice", watchedAt: "2024-06-15T00:00:00Z" },
      { username: "bob", watchedAt: "2024-05-01T00:00:00Z" },
    ]);

    const data = await expectJson<{
      history: { username: string; playCount: number }[];
    }>(await callRouteWithParams(GET, { id: item.id }));

    expect(data.history).toHaveLength(2);
    expect(data.history[0].username).toBe("alice");
    expect(data.history[0].playCount).toBe(2);
    expect(data.history[1].username).toBe("bob");
    expect(data.history[1].playCount).toBe(1);
  });

  it("returns empty history when Plex returns nothing", async () => {
    const item = await createTestMediaItem(libraryId);
    const data = await expectJson<{
      history: { username: string; playCount: number }[];
    }>(await callRouteWithParams(GET, { id: item.id }));
    expect(data.history).toEqual([]);
  });
});
