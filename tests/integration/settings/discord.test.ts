import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

const prisma = getTestPrisma();
const storedSettings = (userId: string) => prisma.appSettings.findUnique({ where: { userId } });

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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson(res);

    expect(body).toEqual({
      webhookUrl: "",
      hasWebhookUrl: false,
      webhookUsername: "",
      webhookAvatarUrl: "",
      notifyMaintenance: false,
      // On by default: a key created by someone else is what this reveals.
      notifyApiKeys: true,
    });
  });

  it("round-trips the API key notification toggle", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await expectJson(await callRoute(PUT, { method: "PUT", body: { notifyApiKeys: false } }), 200);
    let body = await expectJson<{ notifyApiKeys: boolean; notifyMaintenance: boolean }>(await callRoute(GET));
    expect(body.notifyApiKeys).toBe(false);
    expect(body.notifyMaintenance).toBe(false);

    await expectJson(await callRoute(PUT, { method: "PUT", body: { notifyApiKeys: true } }), 200);
    body = await expectJson(await callRoute(GET));
    expect(body.notifyApiKeys).toBe(true);

    await expectJson(await callRoute(PUT, { method: "PUT", body: { notifyApiKeys: "yes" } }), 400);
    expect((await storedSettings(user.id))?.discordNotifyApiKeys).toBe(true);
  });

  it("returns saved discord settings after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: {
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        webhookUsername: "Librariarr",
        webhookAvatarUrl: "https://example.com/avatar.png",
        notifyMaintenance: true,
      },
    }));

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
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    // Stored as sent; only the response masks it.
    expect((await storedSettings(user.id))?.discordWebhookUrl).toBe("https://discord.com/api/webhooks/999/xyz");
  });

  // The URL is where every notification is POSTed: only Discord, over https.
  it.each([
    ["another host", "https://evil.example/api/webhooks/999/xyz"],
    ["a look-alike host", "https://discord.com.evil.example/api/webhooks/999/xyz"],
    ["plain http", "http://discord.com/api/webhooks/999/xyz"],
  ])("rejects a webhook URL on %s", async (_label, webhookUrl) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { webhookUrl } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["webhookUrl: Must be a valid Discord webhook URL (https://discord.com/...)"]);
    expect(await storedSettings(user.id)).toBeNull();
  });

  it("updates only provided fields (partial update)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    // Set initial values
    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: {
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
        webhookUsername: "Bot",
        notifyMaintenance: false,
      },
    }));

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
    expect((await storedSettings(user.id))?.discordWebhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("treats the echoed mask as 'keep the saved URL'", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    await prisma.appSettings.create({
      data: { userId: user.id, discordWebhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });

    // The settings page round-trips whatever GET returned.
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: MASKED_VALUE, webhookUsername: "Bot" },
    });
    const body = await expectJson<{ webhookUrl: string; webhookUsername: string }>(res);
    expect(body.webhookUrl).toBe(MASKED_VALUE);
    expect(body.webhookUsername).toBe("Bot");

    const row = await storedSettings(user.id);
    expect(row?.discordWebhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("clears webhookUrl when empty string is provided", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    // Set a webhook url first
    await prisma.appSettings.create({
      data: { userId: user.id, discordWebhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });

    // Clear it
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { webhookUrl: "" },
    });
    const body = await expectJson<{ webhookUrl: string }>(res);

    // Empty string clears to null, which is returned as ""
    expect(body.webhookUrl).toBe("");
    expect((body as { hasWebhookUrl?: boolean }).hasWebhookUrl).toBe(false);
    expect((await storedSettings(user.id))?.discordWebhookUrl).toBeNull();
  });

  // The settings page sends "" for a cleared field; an absent one is left alone.
  it("clears a saved avatar URL when sent empty, and keeps it when absent", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    await prisma.appSettings.create({
      data: { userId: user.id, discordWebhookAvatarUrl: "https://example.com/avatar.png" },
    });

    await expectJson(await callRoute(PUT, { method: "PUT", body: { notifyMaintenance: true } }));
    expect((await storedSettings(user.id))?.discordWebhookAvatarUrl).toBe("https://example.com/avatar.png");

    const body = await expectJson<{ webhookAvatarUrl: string }>(
      await callRoute(PUT, { method: "PUT", body: { webhookAvatarUrl: "" } }),
    );
    expect(body.webhookAvatarUrl).toBe("");
    expect((await storedSettings(user.id))?.discordWebhookAvatarUrl).toBeNull();
  });

  it("refuses an avatar URL that is not a URL", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { webhookAvatarUrl: "not a url" } });
    expect(await expectJson(res, 400)).toEqual({
      error: "Validation failed",
      details: ["webhookAvatarUrl: Invalid URL"],
    });
  });

  it("accepts an empty body (all fields optional)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { notifyMaintenance: "yes" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["notifyMaintenance: Invalid input: expected boolean, received string"]);
    expect(await storedSettings(user.id)).toBeNull();
  });
});
