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
  let serverId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockGetWatchHistory.mockReset();
    mockGetWatchHistory.mockResolvedValue([]);
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true});
    const server = await createTestServer(userId);
    serverId = server.id;
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
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mockGetWatchHistory).not.toHaveBeenCalled();
  });

  it("returns aggregated watch history", async () => {
    const item = await createTestMediaItem(libraryId, { ratingKey: "4321", duration: 7200000 });
    // PlexClient.getWatchHistory answers newest first, dates as ISO strings.
    mockGetWatchHistory.mockResolvedValue([
      { username: "alice", watchedAt: "2024-06-15T00:00:00.000Z" },
      { username: "alice", watchedAt: "2024-06-01T00:00:00.000Z" },
      { username: "bob", watchedAt: "2024-05-01T00:00:00.000Z" },
    ]);

    const data = await expectJson<{
      history: { username: string; playCount: number; lastPlayedAt: string | null }[];
      serverHistories: { serverId: string; serverName: string; serverType: string; users: unknown[] }[];
    }>(await callRouteWithParams(GET, { id: item.id }));

    expect(data.history).toEqual([
      { username: "alice", playCount: 2, lastPlayedAt: "2024-06-15T00:00:00.000Z" },
      { username: "bob", playCount: 1, lastPlayedAt: "2024-05-01T00:00:00.000Z" },
    ]);
    expect(data.serverHistories).toEqual([
      { serverId: serverId, serverName: "Test Server", serverType: "PLEX", users: data.history },
    ]);
    // Asked for this item, with its runtime for the partial-play cut-off.
    expect(mockGetWatchHistory).toHaveBeenCalledWith("4321", 7200000);
  });

  it("returns empty history when Plex returns nothing", async () => {
    const item = await createTestMediaItem(libraryId);
    const data = await expectJson<{
      history: { username: string; playCount: number }[];
      serverHistories: { users: unknown[] }[];
    }>(await callRouteWithParams(GET, { id: item.id }));
    expect(data.history).toEqual([]);
    expect(data.serverHistories).toHaveLength(1);
    expect(data.serverHistories[0].users).toEqual([]);
  });
});
