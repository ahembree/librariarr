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

const mockGetSessions = vi.fn();
const mockTerminateSession = vi.fn();

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getSessions: mockGetSessions,
      terminateSession: mockTerminateSession,
    };
  }),
}));

// Import route handlers AFTER mocks
import { GET } from "@/app/api/tools/sessions/route";
import { POST } from "@/app/api/tools/sessions/terminate/route";

describe("Tools sessions endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockGetSessions.mockResolvedValue([
      {
        sessionId: "s1",
        userId: "u1",
        username: "user1",
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
    mockTerminateSession.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/tools/sessions -----

  describe("GET /api/tools/sessions", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/tools/sessions" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty sessions when no servers exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/sessions" });
      const body = await expectJson<{ sessions: unknown[] }>(response, 200);
      expect(body.sessions).toEqual([]);
    });

    it("returns sessions from Plex servers", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Test Plex" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/sessions" });
      const body = await expectJson<{
        sessions: {
          sessionId: string;
          username: string;
          title: string;
          serverId: string;
          serverName: string;
          startedAt: number;
        }[];
      }>(response, 200);

      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("s1");
      expect(body.sessions[0].username).toBe("user1");
      expect(body.sessions[0].title).toBe("Movie");
      expect(body.sessions[0].serverName).toBe("Test Plex");
      expect(body.sessions[0].startedAt).toBeDefined();
    });

    it("aggregates sessions from multiple servers", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Server 1" });
      await createTestServer(user.id, { name: "Server 2" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/sessions" });
      const body = await expectJson<{ sessions: unknown[] }>(response, 200);

      // Each server returns one session from the mock
      expect(body.sessions).toHaveLength(2);
    });

    it("skips unreachable servers gracefully", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Good Server" });
      await createTestServer(user.id, { name: "Bad Server" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Make the second call throw
      let callCount = 0;
      mockGetSessions.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Connection refused");
        }
        return Promise.resolve([
          {
            sessionId: "s1",
            userId: "u1",
            username: "user1",
            title: "Movie",
            type: "movie",
            player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "192.168.1.1", local: true },
            session: { bandwidth: 20000, location: "lan" },
          },
        ]);
      });

      const response = await callRoute(GET, { url: "/api/tools/sessions" });
      const body = await expectJson<{ sessions: unknown[] }>(response, 200);

      // Should still return sessions from the good server
      expect(body.sessions).toHaveLength(1);
    });
  });

  // ----- POST /api/tools/sessions/terminate -----

  describe("POST /api/tools/sessions/terminate", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: { serverId: "all", message: "Maintenance" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when message is missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: { serverId: "all" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("terminates specific sessions on a server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "My Plex" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: {
          serverId: server.id,
          sessionIds: ["s1", "s2"],
          message: "Going down for maintenance",
        },
      });
      const body = await expectJson<{ terminated: number; errors: string[] }>(response, 200);

      expect(body.terminated).toBe(2);
      expect(body.errors).toEqual([]);
      expect(mockTerminateSession).toHaveBeenCalledTimes(2);
      expect(mockTerminateSession).toHaveBeenCalledWith("s1", "Going down for maintenance");
      expect(mockTerminateSession).toHaveBeenCalledWith("s2", "Going down for maintenance");
    });

    it("terminates all sessions when serverId is 'all'", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Server 1" });
      await createTestServer(user.id, { name: "Server 2" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: { serverId: "all", message: "Shutting down" },
      });
      const body = await expectJson<{ terminated: number; errors: string[] }>(response, 200);

      // Each server has one session (from mock), both terminated
      expect(body.terminated).toBe(2);
      expect(body.errors).toEqual([]);
    });

    it("reports errors when termination fails", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { name: "Test Server" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      mockTerminateSession.mockRejectedValue(new Error("Network error"));

      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: {
          serverId: server.id,
          sessionIds: ["s1"],
          message: "Bye",
        },
      });
      const body = await expectJson<{ terminated: number; errors: string[] }>(response, 200);

      expect(body.terminated).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("Failed to terminate session s1");
    });

    it("returns zero terminated when no servers match", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/tools/sessions/terminate",
        method: "POST",
        body: {
          serverId: "00000000-0000-0000-0000-000000000000",
          message: "Test",
        },
      });
      const body = await expectJson<{ terminated: number; errors: string[] }>(response, 200);

      expect(body.terminated).toBe(0);
      expect(body.errors).toEqual([]);
    });
  });
});
