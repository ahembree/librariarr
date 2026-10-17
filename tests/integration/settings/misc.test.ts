import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

// Mock recomputeCanonical (used by title preference PUT)
const mockRecomputeCanonical = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dedup/recompute-canonical", () => ({
  recomputeCanonical: mockRecomputeCanonical,
}));

// Import route handlers AFTER mocks
import { POST as discordTest } from "@/app/api/settings/discord/test/route";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { appCache } from "@/lib/cache/memory-cache";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";
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
      expect(mockSendDiscordNotification).not.toHaveBeenCalled();
    });

    // The test posts to whatever URL it is given: only Discord, over https.
    it("refuses to post to a URL that is not a Discord webhook", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: { webhookUrl: "http://192.168.1.10:8080/internal" },
      });
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.details).toEqual(["webhookUrl: Must be a valid Discord webhook URL (https://discord.com/...)"]);
      expect(mockSendDiscordNotification).not.toHaveBeenCalled();
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
      expect(mockSendDiscordNotification).not.toHaveBeenCalled();
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

    it("resolves the echoed mask to the saved webhook URL", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      await getTestPrisma().appSettings.create({
        data: {
          userId: user.id,
          discordWebhookUrl: "https://discord.com/api/webhooks/555/saved",
          discordWebhookUsername: "Saved Bot",
        },
      });

      const response = await callRoute(discordTest, {
        url: "/api/settings/discord/test",
        method: "POST",
        body: { webhookUrl: MASKED_VALUE },
      });
      await expectJson(response, 200);
      // The saved URL, never the mask, and the saved username with it.
      expect(mockSendDiscordNotification).toHaveBeenCalledTimes(1);
      expect(mockSendDiscordNotification).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/555/saved",
        expect.objectContaining({ username: "Saved Bot" })
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
      expect(body).toEqual({ success: false, error: "Discord webhook returned 404: Not Found" });
    });
  });

  // The image-cache routes are covered in image-cache.test.ts.

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
      expect(await getTestPrisma().appSettings.count()).toBe(1);
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
      expect(mockRecomputeCanonical).not.toHaveBeenCalled();
    });

    // Which copy every listing renders changes: canonical copies are re-picked,
    // the cached listings dropped and open pages told to refetch.
    it("updates title preference to a specific server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });
      appCache.set("server-filter:test-entry", { serverIds: [] });
      const events: AppEvent[] = [];
      const unsubscribe = eventBus.subscribe((event) => events.push(event));

      let body: { preferredTitleServerId: string | null; preferredArtworkServerId: string | null };
      try {
        const response = await callRoute(putTitlePreference, {
          url: "/api/settings/title-preference",
          method: "PUT",
          body: { serverId: server.id, field: "title" },
        });
        body = await expectJson(response, 200);
      } finally {
        unsubscribe();
      }
      expect(body).toEqual({ preferredTitleServerId: server.id, preferredArtworkServerId: null });
      const stored = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
      expect(stored?.preferredTitleServerId).toBe(server.id);
      expect(mockRecomputeCanonical).toHaveBeenCalledWith(user.id);
      expect(appCache.get("server-filter:test-entry")).toBeUndefined();
      expect(events).toEqual([
        expect.objectContaining({ type: "sync:completed", userId: user.id, meta: { titlePreferenceChanged: true } }),
      ]);
    });

    it("sets the artwork preference without touching the title one, and clears it with null", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await getTestPrisma().appSettings.create({
        data: { userId: user.id, preferredTitleServerId: server.id },
      });
      setMockSession({ userId: user.id, isLoggedIn: true });

      const set = await expectJson(
        await callRoute(putTitlePreference, {
          url: "/api/settings/title-preference",
          method: "PUT",
          body: { serverId: server.id, field: "artwork" },
        }),
        200,
      );
      expect(set).toEqual({ preferredTitleServerId: server.id, preferredArtworkServerId: server.id });

      const cleared = await expectJson(
        await callRoute(putTitlePreference, {
          url: "/api/settings/title-preference",
          method: "PUT",
          body: { serverId: null, field: "artwork" },
        }),
        200,
      );
      expect(cleared).toEqual({ preferredTitleServerId: server.id, preferredArtworkServerId: null });
    });

    it("returns 400 on invalid body (missing field)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: null },
      });
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toHaveLength(1);
      expect(body.details[0]).toMatch(/^field: /);
      expect(mockRecomputeCanonical).not.toHaveBeenCalled();
    });

    it("returns 400 for a server that does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(putTitlePreference, {
        url: "/api/settings/title-preference",
        method: "PUT",
        body: { serverId: "no-such-server", field: "title" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Server not found");
      expect(await getTestPrisma().appSettings.count()).toBe(0);
      expect(mockRecomputeCanonical).not.toHaveBeenCalled();
    });
  });
});
