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

// Mock discord client
const mockSendDiscordNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: mockSendDiscordNotification,
}));

// Mock image cache
const mockGetImageCacheStats = vi.hoisted(() => vi.fn());
const mockClearImageCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/image-cache/image-cache", () => ({
  getImageCacheStats: mockGetImageCacheStats,
  clearImageCache: mockClearImageCache,
}));

// Mock recomputeCanonical (used by title preference PUT)
const mockRecomputeCanonical = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dedup/recompute-canonical", () => ({
  recomputeCanonical: mockRecomputeCanonical,
}));

// Import route handlers AFTER mocks
import { POST as discordTest } from "@/app/api/settings/discord/test/route";
import {
  GET as getImageCache,
  DELETE as deleteImageCache,
} from "@/app/api/settings/image-cache/route";
import {
  GET as getTitlePreference,
  PUT as putTitlePreference,
} from "@/app/api/settings/title-preference/route";

describe("Settings misc endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockSendDiscordNotification.mockResolvedValue({ ok: true });
    mockGetImageCacheStats.mockResolvedValue({ fileCount: 0, totalSize: 0 });
    mockClearImageCache.mockResolvedValue(undefined);
    mockRecomputeCanonical.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- POST /api/settings/discord/test -----
  describe("POST /api/settings/discord/test", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 when no webhook URL provided and none saved", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ success: boolean; error: string }>(response, 400);
      expect(body.success).toBe(false);
      expect(body.error).toBe("No webhook URL configured");
    });

    it("returns success when webhook works", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      });
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
      expect(mockSendDiscordNotification).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/abc",
        expect.objectContaining({
          embeds: expect.arrayContaining([
            expect.objectContaining({ title: "Test Notification" }),
          ]),
        })
      );
    });

    it("returns 502 when webhook fails", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockSendDiscordNotification.mockResolvedValue({
        ok: false,
        error: "Discord webhook returned 404: Not Found",
      });

      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      });
      const body = await expectJson<{ success: boolean; error: string }>(response, 502);
      expect(body.success).toBe(false);
    });
  });

  // ----- GET /api/settings/image-cache -----
  describe("GET /api/settings/image-cache", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(getImageCache, {
        url: "/api/settings/image-cache",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns cache stats", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetImageCacheStats.mockResolvedValue({ fileCount: 42, totalSize: 1048576 });

      const response = await callRoute(getImageCache, {
        url: "/api/settings/image-cache",
      });
      const body = await expectJson<{ fileCount: number; totalSize: number }>(response, 200);
      expect(body.fileCount).toBe(42);
      expect(body.totalSize).toBe(1048576);
    });
  });

  // ----- DELETE /api/settings/image-cache -----
  describe("DELETE /api/settings/image-cache", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(deleteImageCache, {
        url: "/api/settings/image-cache",
        method: "DELETE",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("clears cache successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(deleteImageCache, {
        url: "/api/settings/image-cache",
        method: "DELETE",
      });
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
      expect(mockClearImageCache).toHaveBeenCalled();
    });
  });

  // ----- GET /api/settings/title-preference -----
  describe("GET /api/settings/title-preference", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(getTitlePreference, {
        url: "/api/settings/title-preference",
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns current preference (creates default settings if none exist)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(getTitlePreference, {
        url: "/api/settings/title-preference",
      });
      const body = await expectJson<{
        preferredTitleServerId: string | null;
        preferredArtworkServerId: string | null;
      }>(response, 200);
      expect(body.preferredTitleServerId).toBeNull();
      expect(body.preferredArtworkServerId).toBeNull();
    });
  });

  // ----- PUT /api/settings/title-preference -----
  describe("PUT /api/settings/title-preference", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: null, field: "title" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("updates title preference to a specific server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: server.id, field: "title" },
      });
      const body = await expectJson<{
        preferredTitleServerId: string | null;
      }>(response, 200);
      expect(body.preferredTitleServerId).toBe(server.id);
      expect(mockRecomputeCanonical).toHaveBeenCalledWith(user.id);
    });

    it("returns 400 on invalid body (missing field)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: null },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when server does not belong to user", async () => {
      const user = await createTestUser();
      const otherUser = await createTestUser({ plexId: "other-plex-id" });
      const otherServer = await createTestServer(otherUser.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: otherServer.id, field: "title" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Server not found");
    });
  });
});
