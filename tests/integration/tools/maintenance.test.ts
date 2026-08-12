import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
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

const sendDiscordNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: (...args: unknown[]) => sendDiscordNotification(...args),
  buildMaintenanceEmbed: vi.fn(() => ({})),
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/tools/maintenance/route";

describe("Tools maintenance endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("Discord maintenance notification", () => {
    async function seedWebhook(userId: string) {
      await getTestPrisma().appSettings.upsert({
        where: { userId },
        update: { discordWebhookUrl: "https://discord/webhook", discordNotifyMaintenance: true },
        create: { userId, discordWebhookUrl: "https://discord/webhook", discordNotifyMaintenance: true },
      });
    }

    it("fires only on an enabled<->disabled transition, not on every edit", async () => {
      const user = await createTestUser();
      await seedWebhook(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Enable -> transition -> 1 notification
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(1);

      // Edit the message while still enabled (what the UI does per keystroke) -> no notification
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down for a bit" } });
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down for a while" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(1);

      // Disable -> transition -> 1 more
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: false, message: "Down for a while" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(2);
    });
  });

  // ----- GET /api/tools/maintenance -----

  describe("GET /api/tools/maintenance", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/tools/maintenance" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns defaults when no settings exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/maintenance" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("");
      expect(body.delay).toBe(30);
    });

    it("returns saved settings", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Save settings first
      await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Maintenance in progress", delay: 60 },
      });

      const response = await callRoute(GET, { url: "/api/tools/maintenance" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(true);
      expect(body.message).toBe("Maintenance in progress");
      expect(body.delay).toBe(60);
    });
  });

  // ----- PUT /api/tools/maintenance -----

  describe("PUT /api/tools/maintenance", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Test" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("creates settings when none exist (upsert create)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Server going down" },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(true);
      expect(body.message).toBe("Server going down");
      expect(body.delay).toBeDefined();
    });

    it("updates existing settings (upsert update)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Create initial settings
      await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Initial message", delay: 30 },
      });

      // Update settings
      const response = await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: false, message: "Updated message", delay: 45 },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("Updated message");
      expect(body.delay).toBe(45);
    });

    it("preserves delay when not provided in update", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Create with specific delay
      await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Maintenance", delay: 90 },
      });

      // Update without delay
      const response = await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: false, message: "Done" },
      });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body.enabled).toBe(false);
      expect(body.message).toBe("Done");
      // delay should remain unchanged at 90
      expect(body.delay).toBe(90);
    });
  });
});
