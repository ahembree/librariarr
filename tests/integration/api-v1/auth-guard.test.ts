import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextResponse } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestApiKey,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

const { apiLogger } = vi.hoisted(() => ({
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger,
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as meGET } from "@/app/api/v1/me/route";
import { GET as serversGET } from "@/app/api/v1/servers/route";
import { POST as cancelPOST } from "@/app/api/v1/sync/cancel/route";
import { withApiKey } from "@/lib/api-keys/guard";
import { getSession } from "@/lib/auth/session";
import { generateApiKey } from "@/lib/api-keys/keys";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { apiKeyRequestLimiter } from "@/lib/rate-limit/rate-limiter";

const prisma = getTestPrisma();

// Rate-limit buckets live in module state for the whole file, so every test
// comes from its own address unless it is testing the buckets themselves.
let ipCounter = 0;
const freshIp = () => `10.30.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function withKey(key: string, ip = freshIp()) {
  return { authorization: `Bearer ${key}`, "x-forwarded-for": ip };
}

describe("/api/v1 authentication guard", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("presenting a key", () => {
    it("401 with a Bearer challenge when no key is sent", async () => {
      const res = await callRoute(meGET, { headers: { "x-forwarded-for": freshIp() } });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="Librariarr"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await expectJson<{ error: string }>(res, 401);
      expect(body.error).toBe("API key required");
    });

    it("ignores a logged-in browser session — the API takes keys only", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      await expectJson(await callRoute(meGET, { headers: { "x-forwarded-for": freshIp() } }), 401);
    });

    it("accepts Authorization: Bearer", async () => {
      const user = await createTestUser();
      const { key, row } = await createTestApiKey(user.id, { name: "Bearer client" });
      const body = await expectJson<{ apiKey: Record<string, unknown> }>(
        await callRoute(meGET, { headers: withKey(key) }),
        200,
      );
      expect(body.apiKey).toMatchObject({ id: row.id, name: "Bearer client", scopes: ["media:read"] });
      expect(body.apiKey).not.toHaveProperty("keyHash");
    });

    it("accepts a lower-case bearer scheme", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      await expectJson(
        await callRoute(meGET, { headers: { authorization: `bearer ${key}`, "x-forwarded-for": freshIp() } }),
        200,
      );
    });

    it("accepts X-Api-Key", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      await expectJson(
        await callRoute(meGET, { headers: { "x-api-key": key, "x-forwarded-for": freshIp() } }),
        200,
      );
    });

    it("uses X-Api-Key when a proxy's Basic credentials occupy Authorization", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      await expectJson(
        await callRoute(meGET, {
          headers: { authorization: "Basic dXNlcjpwYXNz", "x-api-key": key, "x-forwarded-for": freshIp() },
        }),
        200,
      );
    });

    it("400 when the two headers carry different keys", async () => {
      const user = await createTestUser();
      const a = await createTestApiKey(user.id, { name: "a" });
      const b = await createTestApiKey(user.id, { name: "b" });
      const res = await callRoute(meGET, {
        headers: { authorization: `Bearer ${a.key}`, "x-api-key": b.key, "x-forwarded-for": freshIp() },
      });
      await expectJson(res, 400);
    });

    it.each(["api_key", "apikey", "apiKey", "access_token"])(
      "400 for a key in the ?%s query parameter, even alongside a valid header",
      async (param) => {
        const user = await createTestUser();
        const { key } = await createTestApiKey(user.id);
        const res = await callRoute(meGET, {
          url: `/api/v1/me?${param}=${key}`,
          headers: withKey(key),
        });
        const body = await expectJson<{ error: string }>(res, 400);
        expect(body.error).toMatch(/never in the URL/);
      },
    );
  });

  describe("rejecting a key", () => {
    it("401 invalid_token for something that is not a Librariarr key", async () => {
      const res = await callRoute(meGET, { headers: withKey("not-a-key") });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="Librariarr", error="invalid_token"');
      const body = await expectJson<{ error: string }>(res, 401);
      expect(body.error).toBe("Invalid API key");
    });

    it("401 for a well-formed key that was never issued", async () => {
      const res = await callRoute(meGET, { headers: withKey(generateApiKey().key) });
      await expectJson(res, 401);
    });

    it("401 for an expired key", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { expiresAt: new Date(Date.now() - 1000) });
      const body = await expectJson<{ error: string }>(await callRoute(meGET, { headers: withKey(key) }), 401);
      expect(body.error).toBe("API key has expired");
    });

    it("accepts a key right up to its expiry", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { expiresAt: new Date(Date.now() + 60_000) });
      await expectJson(await callRoute(meGET, { headers: withKey(key) }), 200);
    });

    it("403 insufficient_scope, naming the scope, when the key lacks it", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { scopes: ["media:read"] });
      const res = await callRoute(serversGET, { headers: withKey(key) });
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer realm="Librariarr", error="insufficient_scope", scope="servers:read"',
      );
      const body = await expectJson<{ error: string; requiredScope: string }>(res, 403);
      expect(body.requiredScope).toBe("servers:read");
    });

    it("a read-only key cannot reach a write endpoint", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, {
        scopes: ["media:read", "servers:read", "lifecycle:read", "streams:read", "system:read"],
      });
      const res = await callRoute(cancelPOST, {
        method: "POST",
        body: { serverId: "anything" },
        headers: withKey(key),
      });
      await expectJson(res, 403);
    });

    it("grants nothing for a stored scope this version does not know", async () => {
      const user = await createTestUser();
      const { key, row } = await createTestApiKey(user.id);
      await prisma.apiKey.update({ where: { id: row.id }, data: { scopes: ["servers:*"] } });
      await expectJson(await callRoute(serversGET, { headers: withKey(key) }), 403);
    });

    it("fails closed with 503 when the key lookup errors", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      const spy = vi.spyOn(prisma.apiKey, "findUnique").mockRejectedValueOnce(new Error("db down"));
      try {
        const body = await expectJson<{ error: string }>(await callRoute(meGET, { headers: withKey(key) }), 503);
        expect(body.error).not.toMatch(/db down/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("running the handler as the key's owner", () => {
    it("serves the owner's data, with server tokens still masked", async () => {
      const user = await createTestUser();
      await createTestServer(user.id, { name: "Plex", accessToken: "secret-plex-token" });
      const { key } = await createTestApiKey(user.id, { scopes: ["servers:read"] });

      const res = await callRoute(serversGET, { headers: withKey(key) });
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await expectJson<{ servers: Array<{ name: string; accessToken: string }> }>(res, 200);
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].name).toBe("Plex");
      expect(body.servers[0].accessToken).toBe(MASKED_VALUE);
      expect(JSON.stringify(body)).not.toContain("secret-plex-token");
    });

    it("gives a shared handler a session that is the key's owner and refuses cookie writes", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { scopes: ["system:read"] });
      const handler = withApiKey("system:read", async () => {
        const session = await getSession();
        let saveError = "";
        await session.save().catch((e: Error) => (saveError = e.message));
        return NextResponse.json({ userId: session.userId, isLoggedIn: session.isLoggedIn, saveError });
      });
      const body = await expectJson<{ userId: string; isLoggedIn: boolean; saveError: string }>(
        await callRoute(handler, { headers: withKey(key) }),
        200,
      );
      expect(body).toEqual({ userId: user.id, isLoggedIn: true, saveError: expect.stringMatching(/no cookie session/) });
    });

    it("records when and from where the key was last used, at most once a minute", async () => {
      const user = await createTestUser();
      const { key, row } = await createTestApiKey(user.id);
      expect(row.lastUsedAt).toBeNull();

      await expectJson(await callRoute(meGET, { headers: withKey(key, "192.168.7.7") }), 200);
      const first = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      expect(first.lastUsedAt).not.toBeNull();
      expect(first.lastUsedIp).toBe("192.168.7.7");

      await expectJson(await callRoute(meGET, { headers: withKey(key, "192.168.7.8") }), 200);
      const second = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      expect(second.lastUsedAt!.getTime()).toBe(first.lastUsedAt!.getTime());
      expect(second.lastUsedIp).toBe("192.168.7.7");

      // Once the recorded use is over a minute old, the next request refreshes it.
      await prisma.apiKey.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(Date.now() - 2 * 60_000) },
      });
      await expectJson(await callRoute(meGET, { headers: withKey(key, "192.168.7.9") }), 200);
      const third = await prisma.apiKey.findUniqueOrThrow({ where: { id: row.id } });
      expect(third.lastUsedIp).toBe("192.168.7.9");
      expect(third.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("audits writes at INFO and reads at DEBUG, naming the key", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { name: "Automation", scopes: ["sync:write"] });

      await callRoute(cancelPOST, { method: "POST", body: { serverId: "missing" }, headers: withKey(key) });
      expect(apiLogger.info).toHaveBeenCalledWith(
        "API",
        expect.stringMatching(/^POST \/api\/test → 404 \(API key "Automation", lbr_\w{6}…\)$/),
      );

      await callRoute(serversGET, { headers: withKey(key) });
      expect(apiLogger.debug).toHaveBeenCalledWith("API", expect.stringMatching(/^GET .* → 200 \(API key "Automation"/));
    });

    it("never lets a shared cache store a response", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      const artwork = withApiKey("media:read", async () =>
        new NextResponse("img", { headers: { "Cache-Control": "public, max-age=86400" } }),
      );
      const res = await callRoute(artwork, { headers: withKey(key) });
      expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    });

    it("audits a handler that throws, and lets the error surface", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id, { name: "Boom", scopes: ["sync:write"] });
      const failing = withApiKey("sync:write", async () => {
        throw new Error("handler blew up");
      });
      await expect(callRoute(failing, { method: "POST", headers: withKey(key) })).rejects.toThrow(
        "handler blew up",
      );
      expect(apiLogger.info).toHaveBeenCalledWith("API", expect.stringMatching(/→ error \(API key "Boom"/));
    });
  });

  describe("rate limiting", () => {
    it("stops answering a credential that keeps failing, without touching other keys", async () => {
      const user = await createTestUser();
      const { key: goodKey } = await createTestApiKey(user.id);
      const deadKey = generateApiKey().key;
      const ip = freshIp();

      for (let i = 0; i < 20; i++) {
        await expectJson(await callRoute(meGET, { headers: withKey(deadKey, ip) }), 401);
      }
      const limited = await callRoute(meGET, { headers: withKey(deadKey, ip) });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      await expectJson(limited, 429);

      // A valid key from the very same address is unaffected.
      await expectJson(await callRoute(meGET, { headers: withKey(goodKey, ip) }), 200);
      // The first repeated failure was logged at WARN once; the rest at DEBUG.
      const warnings = apiLogger.warn.mock.calls.filter(([, msg]) => String(msg).includes(ip));
      expect(warnings).toHaveLength(1);
    });

    it("cuts off an address flooding distinct bad keys — valid keys included", async () => {
      const user = await createTestUser();
      const { key: goodKey } = await createTestApiKey(user.id);
      const ip = freshIp();

      for (let i = 0; i < 500; i++) {
        await callRoute(meGET, { headers: withKey(`lbr_bad-${i}`, ip) });
      }
      expect(apiLogger.warn).toHaveBeenCalledWith("API", expect.stringMatching(/Too many failed API key attempts/));
      await expectJson(await callRoute(meGET, { headers: withKey(goodKey, ip) }), 429);
      // Another address is not affected.
      await expectJson(await callRoute(meGET, { headers: withKey(goodKey) }), 200);
    });

    it("never logs the presented key", async () => {
      const deadKey = generateApiKey().key;
      await callRoute(meGET, { headers: withKey(deadKey) });
      const logged = JSON.stringify([...apiLogger.warn.mock.calls, ...apiLogger.debug.mock.calls]);
      expect(logged).not.toContain(deadKey);
      expect(logged).toContain(deadKey.slice(0, 10));
    });

    it("429 once a key exceeds its request budget", async () => {
      const user = await createTestUser();
      const { key } = await createTestApiKey(user.id);
      const spy = vi
        .spyOn(apiKeyRequestLimiter, "check")
        .mockReturnValueOnce({ limited: true, remaining: 0, retryAfterMs: 12_000 });
      try {
        const res = await callRoute(meGET, { headers: withKey(key) });
        expect(res.headers.get("retry-after")).toBe("12");
        await expectJson(res, 429);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
