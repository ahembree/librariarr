import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestApiKey,
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

const { mockSendDiscord } = vi.hoisted(() => ({ mockSendDiscord: vi.fn() }));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: mockSendDiscord,
}));

import { GET, POST } from "@/app/api/settings/api-keys/route";
import { DELETE } from "@/app/api/settings/api-keys/[id]/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { API_KEY_PATTERN, verifyApiKey } from "@/lib/api-keys/keys";
import { MAX_API_KEYS } from "@/lib/api-keys/manage";
import { RECENT_LOGIN_WINDOW_MS } from "@/lib/auth/recent-login";
import { authGlobalRateLimiter, authRateLimiter } from "@/lib/rate-limit/rate-limiter";
import { READ_ONLY_SCOPES } from "@/lib/api-keys/scopes";

const prisma = getTestPrisma();

interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// A Plex-only account (no local password) signed in just now — the state in
// which creating a key needs nothing more. Password and stale-login cases are
// under "step-up" below.
async function login(authenticatedAt: number | undefined = Date.now()) {
  const user = await createTestUser();
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok", authenticatedAt });
  return user;
}

function create(body: unknown) {
  return callRoute(POST, { url: "/api/settings/api-keys", method: "POST", body });
}

let ipCounter = 0;
function callMe(key: string) {
  return callRoute(meGET, {
    url: "/api/v1/me",
    headers: { authorization: `Bearer ${key}`, "x-forwarded-for": `10.20.0.${++ipCounter}` },
  });
}

describe("/api/settings/api-keys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("authentication", () => {
    it("GET returns 401 without a session", async () => {
      await expectJson(await callRoute(GET), 401);
    });

    it("POST returns 401 without a session", async () => {
      await expectJson(await create({ name: "x", scopes: ["media:read"], expiresAt: null }), 401);
    });

    it("DELETE returns 401 without a session", async () => {
      await expectJson(await callRouteWithParams(DELETE, { id: "anything" }, { method: "DELETE" }), 401);
    });

    it("an API key cannot manage API keys — these routes read only the cookie session", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, {
        scopes: ["media:read", "sync:write", "lifecycle:execute", "streams:write"],
      });
      const res = await callRoute(GET, { headers: { authorization: `Bearer ${key}` } });
      await expectJson(res, 401);
    });
  });

  describe("POST", () => {
    it("returns the key exactly once and stores only its SHA-256", async () => {
      const user = await login();
      const res = await create({ name: "Home Assistant", scopes: ["media:read"], expiresAt: inDays(30) });
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await expectJson<{ key: string; apiKey: ApiKeyDto & { keyHash?: string } }>(res, 201);

      expect(body.key).toMatch(API_KEY_PATTERN);
      expect(body.apiKey.name).toBe("Home Assistant");
      expect(body.apiKey.prefix).toBe(body.key.slice(0, 10));
      expect(body.apiKey.keyHash).toBeUndefined();

      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: body.apiKey.id } });
      expect(row.userId).toBe(user.id);
      // A salted scrypt hash of the key, not the key or a fast digest of it.
      expect(row.keyHash).toMatch(/^scrypt\$/);
      expect(await verifyApiKey(body.key, row.keyHash)).toBe(true);
      // Nothing about the stored row reveals the key.
      expect(JSON.stringify(row)).not.toContain(body.key.slice(10));

      // …and the list never returns it again.
      const list = await expectJson<{ apiKeys: Array<Record<string, unknown>> }>(await callRoute(GET), 200);
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(body.key);
      expect(serialized).not.toContain(row.keyHash);
      expect(list.apiKeys[0]).not.toHaveProperty("keyHash");
    });

    it("issues a key that authenticates against the public API", async () => {
      await login();
      const body = await expectJson<{ key: string }>(
        await create({ name: "Script", scopes: ["media:read"], expiresAt: null }),
        201,
      );
      const me = await expectJson<{ apiKey: { name: string } }>(await callMe(body.key), 200);
      expect(me.apiKey.name).toBe("Script");
    });

    it("stores implied read scopes with a write scope", async () => {
      await login();
      const body = await expectJson<{ apiKey: ApiKeyDto }>(
        await create({ name: "Sync bot", scopes: ["sync:write"], expiresAt: null }),
        201,
      );
      expect(body.apiKey.scopes).toEqual(["servers:read", "sync:write"]);
    });

    it("accepts a read-only key (every read scope)", async () => {
      await login();
      const body = await expectJson<{ apiKey: ApiKeyDto }>(
        await create({ name: "Dashboard", scopes: READ_ONLY_SCOPES, expiresAt: inDays(90) }),
        201,
      );
      expect(body.apiKey.scopes).toEqual([...READ_ONLY_SCOPES]);
    });

    it("stores null for a key that never expires", async () => {
      await login();
      const body = await expectJson<{ apiKey: ApiKeyDto }>(
        await create({ name: "Forever", scopes: ["media:read"], expiresAt: null }),
        201,
      );
      expect(body.apiKey.expiresAt).toBeNull();
    });

    it("stores the expiry it was given", async () => {
      await login();
      const expiresAt = inDays(7);
      const body = await expectJson<{ apiKey: ApiKeyDto }>(
        await create({ name: "Week", scopes: ["media:read"], expiresAt }),
        201,
      );
      expect(new Date(body.apiKey.expiresAt!).toISOString()).toBe(expiresAt);
    });

    it("rejects an expiry in the past", async () => {
      await login();
      const res = await create({ name: "Past", scopes: ["media:read"], expiresAt: inDays(-1) });
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toMatch(/future/);
      expect(await prisma.apiKey.count()).toBe(0);
    });

    it.each([
      ["an unknown scope", { name: "x", scopes: ["media:write"], expiresAt: null }],
      ["no scopes", { name: "x", scopes: [], expiresAt: null }],
      ["an empty name", { name: "   ", scopes: ["media:read"], expiresAt: null }],
      ["a name over 64 characters", { name: "x".repeat(65), scopes: ["media:read"], expiresAt: null }],
      ["a newline in the name", { name: "ok\nFAKE LOG LINE", scopes: ["media:read"], expiresAt: null }],
      ["a right-to-left override in the name", { name: "Dash\u202Eboard", scopes: ["media:read"], expiresAt: null }],
      ["a malformed expiry", { name: "x", scopes: ["media:read"], expiresAt: "next tuesday" }],
      ["a missing expiry", { name: "x", scopes: ["media:read"] }],
    ])("rejects %s", async (_label, payload) => {
      await login();
      await expectJson<{ error: string }>(await create(payload), 400);
      expect(await prisma.apiKey.count()).toBe(0);
    });

    it("trims the name", async () => {
      await login();
      const body = await expectJson<{ apiKey: ApiKeyDto }>(
        await create({ name: "  Padded  ", scopes: ["media:read"], expiresAt: null }),
        201,
      );
      expect(body.apiKey.name).toBe("Padded");
    });

    it("refuses a duplicate name with 409", async () => {
      await login();
      await expectJson(await create({ name: "Same", scopes: ["media:read"], expiresAt: null }), 201);
      const body = await expectJson<{ error: string }>(
        await create({ name: "Same", scopes: ["system:read"], expiresAt: null }),
        409,
      );
      expect(body.error).toMatch(/already exists/);
    });

    it("surfaces an unexpected database error instead of reporting a name clash", async () => {
      await login();
      const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection reset"));
      try {
        await expect(
          create({ name: "Boom", scopes: ["media:read"], expiresAt: null }),
        ).rejects.toThrow("connection reset");
      } finally {
        spy.mockRestore();
      }
    });

    it(`caps the number of keys at ${MAX_API_KEYS}`, async () => {
      const user = await login();
      for (let i = 0; i < MAX_API_KEYS; i++) await createTestApiKey(user.id, { name: `k${i}` });
      const body = await expectJson<{ error: string }>(
        await create({ name: "one too many", scopes: ["media:read"], expiresAt: null }),
        400,
      );
      expect(body.error).toMatch(String(MAX_API_KEYS));
    });

    it("holds the cap when requests race for the last slots", async () => {
      const user = await login();
      for (let i = 0; i < MAX_API_KEYS - 2; i++) await createTestApiKey(user.id, { name: `k${i}` });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => create({ name: `racer ${i}`, scopes: ["media:read"], expiresAt: null })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 400, 400, 400, 400]);
      expect(await prisma.apiKey.count({ where: { userId: user.id } })).toBe(MAX_API_KEYS);
    });
  });

  describe("GET", () => {
    it("lists keys newest first with last-use details", async () => {
      const user = await login();
      const older = await createTestApiKey(user.id, { name: "Older" });
      await prisma.apiKey.update({
        where: { id: older.row.id },
        data: { createdAt: new Date(Date.now() - 60_000), lastUsedAt: new Date(), lastUsedIp: "10.0.0.5" },
      });
      await createTestApiKey(user.id, { name: "Newer" });

      const res = await callRoute(GET);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await expectJson<{ apiKeys: ApiKeyDto[] }>(res, 200);
      expect(body.apiKeys.map((k) => k.name)).toEqual(["Newer", "Older"]);
      expect(body.apiKeys[1].lastUsedIp).toBe("10.0.0.5");
      expect(body.apiKeys[1].lastUsedAt).not.toBeNull();
    });

    it("returns an empty list when there are no keys", async () => {
      await login();
      const body = await expectJson<{ apiKeys: ApiKeyDto[] }>(await callRoute(GET), 200);
      expect(body.apiKeys).toEqual([]);
    });
  });

  describe("DELETE", () => {
    it("deletes the key and revokes it on the very next request", async () => {
      const user = await login();
      const { key, row } = await createTestApiKey(user.id);
      await expectJson(await callMe(key), 200);

      const res = await callRouteWithParams(DELETE, { id: row.id }, { method: "DELETE" });
      await expectJson(res, 200);
      expect(await prisma.apiKey.count()).toBe(0);

      const after = await callMe(key);
      const body = await expectJson<{ error: string }>(after, 401);
      expect(body.error).toBe("Invalid API key");
    });

    it("returns 404 for an unknown or already-deleted key", async () => {
      const user = await login();
      const { row } = await createTestApiKey(user.id);
      await expectJson(await callRouteWithParams(DELETE, { id: row.id }, { method: "DELETE" }), 200);
      await expectJson(await callRouteWithParams(DELETE, { id: row.id }, { method: "DELETE" }), 404);
      await expectJson(await callRouteWithParams(DELETE, { id: "nope" }, { method: "DELETE" }), 404);
    });

    it("answers 404, not 500, when another request deleted the key first", async () => {
      const user = await login();
      const { row } = await createTestApiKey(user.id);
      // The key is found, then gone by the time the delete runs.
      const spy = vi.spyOn(prisma.apiKey, "deleteMany").mockResolvedValueOnce({ count: 0 });
      try {
        await expectJson(await callRouteWithParams(DELETE, { id: row.id }, { method: "DELETE" }), 404);
      } finally {
        spy.mockRestore();
      }
    });

    it("leaves other keys working", async () => {
      const user = await login();
      const doomed = await createTestApiKey(user.id, { name: "doomed" });
      const kept = await createTestApiKey(user.id, { name: "kept" });
      await expectJson(await callRouteWithParams(DELETE, { id: doomed.row.id }, { method: "DELETE" }), 200);
      await expectJson(await callMe(kept.key), 200);
    });
  });

  describe("POST — step-up", () => {
    const PASSWORD = "correct horse battery staple";
    const stores = () =>
      [authRateLimiter, authGlobalRateLimiter].map(
        (l) => (l as unknown as { store: Map<string, unknown> }).store,
      );

    afterEach(() => {
      for (const store of stores()) store.clear();
    });

    async function loginWithPassword() {
      const user = await login(Date.now() - 2 * RECENT_LOGIN_WINDOW_MS);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: bcrypt.hashSync(PASSWORD, 4) },
      });
      return user;
    }

    const body = (extra: Record<string, unknown> = {}) => ({
      name: "Dash",
      scopes: ["media:read"],
      expiresAt: null,
      ...extra,
    });

    it("an account with a password must give it, and a wrong one creates nothing", async () => {
      await loginWithPassword();
      const missing = await expectJson<{ code: string }>(await create(body()), 400);
      expect(missing.code).toBe("password_required");
      const wrong = await expectJson<{ code: string }>(await create(body({ currentPassword: "nope" })), 403);
      expect(wrong.code).toBe("password_incorrect");
      expect(await prisma.apiKey.count()).toBe(0);
      await expectJson(await create(body({ currentPassword: PASSWORD })), 201);
      expect(await prisma.apiKey.count()).toBe(1);
    });

    it("a wrong password costs what a failed login does — even the right one is refused after ten", async () => {
      await loginWithPassword();
      for (let i = 0; i < 10; i++) {
        await expectJson(await create(body({ currentPassword: "nope" })), 403);
      }
      const limited = await create(body({ currentPassword: PASSWORD }));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(await prisma.apiKey.count()).toBe(0);
    });

    it("correct passwords are never counted against the budget", async () => {
      await loginWithPassword();
      for (let i = 0; i < 12; i++) {
        await expectJson(await create(body({ name: `k${i}`, currentPassword: PASSWORD })), 201);
      }
    });

    it("an account without a password needs a login from the last window", async () => {
      await login(Date.now() - RECENT_LOGIN_WINDOW_MS - 1000);
      const stale = await expectJson<{ code: string; error: string }>(await create(body()), 403);
      expect(stale.code).toBe("reauth_required");
      expect(stale.error).toMatch(/sign out, sign back in/i);
      expect(await prisma.apiKey.count()).toBe(0);

      // A session with no login stamp at all (one from before the stamp existed).
      const unstamped = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: unstamped.id, plexToken: "tok" });
      expect((await create(body())).status).toBe(403);

      await login(Date.now() - 1000);
      await expectJson(await create(body()), 201);
    });

    it("ignores a password sent for an account that has none", async () => {
      await login();
      await expectJson(await create(body({ currentPassword: "anything" })), 201);
    });
  });

  describe("Discord notifications", () => {
    beforeEach(() => {
      mockSendDiscord.mockReset();
      mockSendDiscord.mockResolvedValue({ ok: true });
    });

    async function loginWithWebhook(notifyApiKeys = true) {
      const user = await login();
      await prisma.appSettings.create({
        data: {
          userId: user.id,
          discordWebhookUrl: "https://discord.com/api/webhooks/1/abc",
          discordWebhookUsername: "Bot",
          discordNotifyApiKeys: notifyApiKeys,
        },
      });
      return user;
    }

    it("announces a created key — name, prefix, scopes and expiry, never the key", async () => {
      await loginWithWebhook();
      const res = await create({ name: "n8n", scopes: ["sync:write"], expiresAt: null });
      const { key, apiKey } = await expectJson<{ key: string; apiKey: ApiKeyDto }>(res, 201);

      await vi.waitFor(() => expect(mockSendDiscord).toHaveBeenCalledTimes(1));
      const [url, payload] = mockSendDiscord.mock.calls[0] as [string, { username: string; embeds: Array<Record<string, unknown>> }];
      expect(url).toBe("https://discord.com/api/webhooks/1/abc");
      expect(payload.username).toBe("Bot");
      expect(payload.embeds[0].title).toBe("API Key Created");
      const text = JSON.stringify(payload);
      expect(text).toContain("n8n");
      expect(text).toContain(`${apiKey.prefix}…`);
      expect(text).toContain("servers:read, sync:write");
      expect(text).not.toContain(key);
    });

    it("announces a deleted key", async () => {
      const user = await loginWithWebhook();
      const { row } = await createTestApiKey(user.id, { name: "Old bot" });
      await expectJson(await callRouteWithParams(DELETE, { id: row.id }, { method: "DELETE" }), 200);
      await vi.waitFor(() => expect(mockSendDiscord).toHaveBeenCalledTimes(1));
      const [, payload] = mockSendDiscord.mock.calls[0] as [string, { embeds: Array<Record<string, unknown>> }];
      expect(payload.embeds[0].title).toBe("API Key Deleted");
      expect(JSON.stringify(payload)).toContain("Old bot");
    });

    it("stays quiet when the toggle is off, or no webhook is set", async () => {
      await loginWithWebhook(false);
      await expectJson(await create({ name: "quiet", scopes: ["media:read"], expiresAt: null }), 201);
      await login();
      await expectJson(await create({ name: "no webhook", scopes: ["media:read"], expiresAt: null }), 201);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendDiscord).not.toHaveBeenCalled();
    });

    it("a failing webhook never fails the request", async () => {
      await loginWithWebhook();
      mockSendDiscord.mockRejectedValue(new Error("discord down"));
      await expectJson(await create({ name: "still made", scopes: ["media:read"], expiresAt: null }), 201);
      await vi.waitFor(() => expect(mockSendDiscord).toHaveBeenCalled());
    });
  });
});
