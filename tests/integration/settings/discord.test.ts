import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/settings/discord/route";
import { MASKED_VALUE } from "@/lib/api/sanitize";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/discord
// ---------------------------------------------------------------------------
describe("GET /api/settings/discord", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default/empty discord settings when none configured", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{
      webhookUrl: string;
      webhookUsername: string;
      webhookAvatarUrl: string;
      notifyMaintenance: boolean;
    }>(res);

    expect(body.webhookUrl).toBe("");
    expect(body.webhookUsername).toBe("");
    expect(body.webhookAvatarUrl).toBe("");
    expect(body.notifyMaintenance).toBe(false);
  });

  it("returns saved discord settings after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, {
      method: "PUT",
      body: {
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        webhookUsername: "Librariarr",
        webhookAvatarUrl: "https://example.com/avatar.png",
        notifyMaintenance: true,
      },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{
      webhookUrl: string;
      webhookUsername: string;
      webhookAvatarUrl: string;
      notifyMaintenance: boolean;
    }>(res);

    // A webhook URL is a bearer credential: never returned verbatim.
    expect(body.webhookUrl).toBe(MASKED_VALUE);
    expect((body as { hasWebhookUrl?: boolean }).hasWebhookUrl).toBe(true);
    expect(body.webhookUsername).toBe("Librariarr");
    expect(body.webhookAvatarUrl).toBe("https://example.com/avatar.png");
    expect(body.notifyMaintenance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/discord
// ---------------------------------------------------------------------------
describe("PUT /api/settings/discord", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });
    await expectJson(res, 401);
  });

  it("saves and returns updated discord settings with webhookUrl", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "https://discord.com/api/webhooks/999/xyz" },
    });
    const body = await expectJson<{
      webhookUrl: string;
      webhookUsername: string;
      webhookAvatarUrl: string;
      notifyMaintenance: boolean;
    }>(res);

    expect(body.webhookUrl).toBe(MASKED_VALUE);
    expect((body as { hasWebhookUrl?: boolean }).hasWebhookUrl).toBe(true);
    // Defaults for other fields
    expect(body.webhookUsername).toBe("");
    expect(body.webhookAvatarUrl).toBe("");
    expect(body.notifyMaintenance).toBe(false);
  });

  it("updates only provided fields (partial update)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Set initial values
    await callRoute(PUT, {
      method: "PUT",
      body: {
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        webhookUsername: "Bot",
        notifyMaintenance: false,
      },
    });

    // Update only notifyMaintenance
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { notifyMaintenance: true },
    });
    const body = await expectJson<{
      webhookUrl: string;
      webhookUsername: string;
      notifyMaintenance: boolean;
    }>(res);

    // A webhook URL is a bearer credential: never returned verbatim.
    expect(body.webhookUrl).toBe(MASKED_VALUE);
    expect((body as { hasWebhookUrl?: boolean }).hasWebhookUrl).toBe(true);
    expect(body.webhookUsername).toBe("Bot");
    expect(body.notifyMaintenance).toBe(true);
  });

  it("treats the echoed mask as 'keep the saved URL'", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });

    // The settings page round-trips whatever GET returned.
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: MASKED_VALUE, webhookUsername: "Bot" },
    });
    const body = await expectJson<{ webhookUrl: string; webhookUsername: string }>(res);
    expect(body.webhookUrl).toBe(MASKED_VALUE);
    expect(body.webhookUsername).toBe("Bot");

    const { getTestPrisma } = await import("../../setup/test-db");
    const row = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.discordWebhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("clears webhookUrl when empty string is provided", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Set a webhook url first
    await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });

    // Clear it
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "" },
    });
    const body = await expectJson<{ webhookUrl: string }>(res);

    // Empty string clears to null, which is returned as ""
    expect(body.webhookUrl).toBe("");
  });

  it("accepts an empty body (all fields optional)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {},
    });
    // All fields are optional, so this should succeed
    const body = await expectJson<{
      webhookUrl: string;
      notifyMaintenance: boolean;
    }>(res);

    expect(body.webhookUrl).toBe("");
    expect(body.notifyMaintenance).toBe(false);
  });

  it("rejects non-boolean notifyMaintenance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { notifyMaintenance: "yes" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });
});
