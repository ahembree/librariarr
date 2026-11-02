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

const { sendDiscordNotification, buildMaintenanceEmbed } = vi.hoisted(() => ({
  sendDiscordNotification: vi.fn().mockResolvedValue(undefined),
  buildMaintenanceEmbed: vi.fn(() => ({})),
}));
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: (...args: unknown[]) => sendDiscordNotification(...args),
  buildMaintenanceEmbed,
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/tools/maintenance/route";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/abcDEFghiJKLmnoPQRstu";

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
        update: { discordWebhookUrl: WEBHOOK_URL, discordNotifyMaintenance: true },
        create: { userId, discordWebhookUrl: WEBHOOK_URL, discordNotifyMaintenance: true },
      });
    }

    it("fires only on an enabled<->disabled transition, not on every edit", async () => {
      const user = await createTestUser();
      await seedWebhook(user.id);
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Enable -> transition -> 1 notification
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(1);
      expect(buildMaintenanceEmbed).toHaveBeenLastCalledWith(true, "Down");
      expect(sendDiscordNotification).toHaveBeenLastCalledWith(WEBHOOK_URL, {
        username: "Librariarr",
        avatar_url: undefined,
        embeds: [{}],
      });

      // Edit the message while still enabled (what the UI does per keystroke) -> no notification
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down for a bit" } });
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true, message: "Down for a while" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(1);

      // Disable -> transition -> 1 more
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: false, message: "Down for a while" } });
      expect(sendDiscordNotification).toHaveBeenCalledTimes(2);
      expect(buildMaintenanceEmbed).toHaveBeenLastCalledWith(false, "Down for a while");
    });

    it("stays silent when the notification is turned off or no webhook is set", async () => {
      const user = await createTestUser();
      await getTestPrisma().appSettings.create({
        data: { userId: user.id, discordWebhookUrl: WEBHOOK_URL, discordNotifyMaintenance: false },
      });
      setMockSession({ userId: user.id, isLoggedIn: true });

      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true } });
      await getTestPrisma().appSettings.update({
        where: { userId: user.id },
        data: { discordWebhookUrl: null, discordNotifyMaintenance: true },
      });
      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: false } });

      expect(sendDiscordNotification).not.toHaveBeenCalled();
    });
  });

  describe("realtime announcement", () => {
    it("announces settings:changed to open tabs on a toggle, and only then", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const events: AppEvent[] = [];
      const unsubscribe = eventBus.subscribe((event) => events.push(event));
      try {
        const put = (body: Record<string, unknown>) =>
          callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body });
        await put({ enabled: true, message: "Down" });
        await put({ enabled: true, message: "Down for a bit" }); // an edit, not a toggle
        await put({ enabled: false });

        expect(events.filter((e) => e.type === "settings:changed")).toEqual([
          expect.objectContaining({ userId: user.id, meta: { maintenanceMode: true } }),
          expect.objectContaining({ userId: user.id, meta: { maintenanceMode: false } }),
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  describe("Discord maintenance notification message", () => {
    it("carries the stored message when the request leaves it out (the public API's PUT keeps it)", async () => {
      const user = await createTestUser();
      await getTestPrisma().appSettings.create({
        data: {
          userId: user.id,
          discordWebhookUrl: "https://discord/webhook",
          discordNotifyMaintenance: true,
          maintenanceMessage: "Back at 6pm",
        },
      });
      setMockSession({ userId: user.id, isLoggedIn: true });

      await callRoute(PUT, { url: "/api/tools/maintenance", method: "PUT", body: { enabled: true } });

      expect(buildMaintenanceEmbed).toHaveBeenCalledWith(true, "Back at 6pm");
      expect(sendDiscordNotification).toHaveBeenCalledTimes(1);
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/tools/maintenance" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body).toEqual({
        enabled: false,
        message: "",
        delay: 30,
        discordNotifyMaintenance: false,
        excludedUsers: [],
      });
    });

    it("returns saved settings", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Save settings first
      await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, message: "Maintenance in progress", delay: 60, excludedUsers: ["alice"] },
      });

      const response = await callRoute(GET, { url: "/api/tools/maintenance" });
      const body = await expectJson<{
        enabled: boolean;
        message: string;
        delay: number;
      }>(response, 200);

      expect(body).toEqual({
        enabled: true,
        message: "Maintenance in progress",
        delay: 60,
        discordNotifyMaintenance: false,
        excludedUsers: ["alice"],
      });
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
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      // Not sent, so the column default.
      expect(body.delay).toBe(30);
      const stored = await getTestPrisma().appSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(stored).toMatchObject({ maintenanceMode: true, maintenanceMessage: "Server going down", maintenanceDelay: 30 });
    });

    it("refuses a delay outside 0–3600 seconds and saves nothing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(PUT, {
        url: "/api/tools/maintenance",
        method: "PUT",
        body: { enabled: true, delay: 3601 },
      });
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toEqual([expect.stringMatching(/^delay: /)]);
      expect(await getTestPrisma().appSettings.count()).toBe(0);
    });

    it("updates existing settings (upsert update)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

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
