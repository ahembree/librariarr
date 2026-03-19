import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
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

// Mock the media server factory
const mockGetSessions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockImplementation(function () {
    return {
      getSessions: mockGetSessions,
    };
  }),
}));

// Mock Plex friends API
const mockGetPlexFriends = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plex/auth", () => ({
  getPlexFriends: mockGetPlexFriends,
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/tools/users/route";

describe("GET /api/tools/users", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockGetSessions.mockResolvedValue([]);
    mockGetPlexFriends.mockResolvedValue([]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/tools/users",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns owner username when no servers exist", async () => {
    const user = await createTestUser({ username: "admin" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/users",
    });
    const body = await expectJson<{ users: string[] }>(response, 200);
    // Only the owner username since no servers and no friends
    expect(body.users).toEqual(["admin"]);
  });

  it("returns users from connected servers and Plex friends", async () => {
    const user = await createTestUser({
      username: "admin",
      plexToken: "plex-tok",
    });
    await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Mock Plex friends
    mockGetPlexFriends.mockResolvedValue(["friend1", "friend2"]);

    // Mock session users from the server
    mockGetSessions.mockResolvedValue([
      {
        sessionId: "s1",
        userId: "u1",
        username: "viewer1",
        title: "Movie",
        type: "movie",
        player: {
          product: "Plex Web",
          platform: "Chrome",
          state: "playing",
          address: "192.168.1.1",
          local: true,
        },
        session: { bandwidth: 20000, location: "lan" },
      },
    ]);

    const response = await callRoute(GET, {
      url: "/api/tools/users",
    });
    const body = await expectJson<{ users: string[] }>(response, 200);

    // Should contain owner, friends, and session users, sorted
    expect(body.users).toContain("admin");
    expect(body.users).toContain("friend1");
    expect(body.users).toContain("friend2");
    expect(body.users).toContain("viewer1");
    // Sorted alphabetically
    expect(body.users).toEqual([...body.users].sort());
  });

  it("handles server connection errors gracefully", async () => {
    const user = await createTestUser({
      username: "admin",
      plexToken: "plex-tok",
    });
    await createTestServer(user.id, { name: "Bad Server" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Server throws error
    mockGetSessions.mockRejectedValue(new Error("Connection refused"));
    mockGetPlexFriends.mockResolvedValue([]);

    const response = await callRoute(GET, {
      url: "/api/tools/users",
    });
    const body = await expectJson<{ users: string[] }>(response, 200);

    // Should still return the owner username
    expect(body.users).toContain("admin");
  });
});
