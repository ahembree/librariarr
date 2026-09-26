import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
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

import { GET, POST } from "@/app/api/settings/api-keys/route";
import { DELETE } from "@/app/api/settings/api-keys/[id]/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { API_KEY_PATTERN } from "@/lib/api-keys/keys";
import { MAX_API_KEYS } from "@/lib/api-keys/manage";
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

async function login() {
  const user = await createTestUser();
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
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
      expect(row.keyHash).toBe(createHash("sha256").update(body.key).digest("hex"));
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

    it(`caps the number of keys at ${MAX_API_KEYS}`, async () => {
      const user = await login();
      for (let i = 0; i < MAX_API_KEYS; i++) await createTestApiKey(user.id, { name: `k${i}` });
      const body = await expectJson<{ error: string }>(
        await create({ name: "one too many", scopes: ["media:read"], expiresAt: null }),
        400,
      );
      expect(body.error).toMatch(String(MAX_API_KEYS));
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

    it("leaves other keys working", async () => {
      const user = await login();
      const doomed = await createTestApiKey(user.id, { name: "doomed" });
      const kept = await createTestApiKey(user.id, { name: "kept" });
      await expectJson(await callRouteWithParams(DELETE, { id: doomed.row.id }, { method: "DELETE" }), 200);
      await expectJson(await callMe(kept.key), 200);
    });
  });
});
