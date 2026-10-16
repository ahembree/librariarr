import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { apiKey: { findUnique: m.findUnique, findMany: m.findMany, updateMany: m.updateMany } },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { debug: m.debug, info: m.info, warn: m.warn, error: m.error },
}));
// A cheap stand-in for scrypt, so a thousand keys can be verified in a test.
// A stored hash "h:<key>" verifies exactly that key.
vi.mock("@/lib/api-keys/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-keys/keys")>()),
  verifyApiKey: async (key: string, stored: string) => stored === `h:${key}`,
}));

import { _resetVerifiedApiKeysForTesting, authenticateApiKey, withApiKey } from "@/lib/api-keys/guard";
import { apiKeyLookupPrefix, newApiKey } from "@/lib/api-keys/keys";
import {
  apiKeyCredentialFailureLimiter,
  apiKeyRequestLimiter,
  apiKeyUnknownLookupFloor,
  apiKeyVerificationFloor,
} from "@/lib/rate-limit/rate-limiter";

interface Row {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

const table = new Map<string, Row>();
function serveTable() {
  m.findMany.mockImplementation(async ({ where }: { where: { prefix: string } }) =>
    [...table.values()].filter((row) => row.prefix === where.prefix),
  );
  m.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = table.get(where.id);
    if (!row) return null;
    return Object.fromEntries(Object.entries(row).filter(([f]) => f !== "keyHash"));
  });
}

function addKey(id: string, scopes = ["media:read"]): string {
  const key = newApiKey();
  table.set(id, {
    id,
    userId: "user-1",
    name: `Key ${id}`,
    prefix: apiKeyLookupPrefix(key),
    keyHash: `h:${key}`,
    scopes,
    expiresAt: null,
    lastUsedAt: new Date(),
  });
  return key;
}

let ip = 0;
function request(headers: Record<string, string>, method = "GET", url = "http://localhost/api/v1/me") {
  return new NextRequest(url, { method, headers: { "x-forwarded-for": `10.9.${++ip % 250}.1`, ...headers } });
}

const storeOf = (l: unknown) => (l as { store: Map<string, unknown> }).store;
function clearFloors() {
  storeOf(apiKeyVerificationFloor).clear();
  storeOf(apiKeyUnknownLookupFloor).clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
  _resetVerifiedApiKeysForTesting();
  clearFloors();
  serveTable();
  m.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  clearFloors();
});

describe("credential headers", () => {
  it("refuses two different lbr_ keys with 400", async () => {
    const r = await authenticateApiKey(
      request({ authorization: `Bearer ${newApiKey()}`, "x-api-key": newApiKey() }),
      null,
    );
    expect(r.ok === false && r.response.status).toBe(400);
    if (!r.ok) expect((await r.response.json()).error).toMatch(/different keys/);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("uses an lbr_ Bearer when X-Api-Key holds something else", async () => {
    const key = addKey("k1");
    const r = await authenticateApiKey(request({ authorization: `Bearer ${key}`, "x-api-key": "proxy-token" }), null);
    expect(r.ok).toBe(true);
  });
});

describe("failures", () => {
  it("locks out a credential after 20 failures without another lookup", async () => {
    const forged = newApiKey();
    for (let i = 0; i < apiKeyCredentialFailureLimiter.maxAttempts; i++) {
      const r = await authenticateApiKey(request({ "x-api-key": forged }), null);
      expect(r.ok === false && r.response.status).toBe(401);
    }
    const lookups = m.findMany.mock.calls.length;
    const r = await authenticateApiKey(request({ "x-api-key": forged }), null);
    expect(r.ok === false && r.response.status).toBe(429);
    if (!r.ok) expect(Number(r.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(m.findMany.mock.calls.length).toBe(lookups);
    // The credential failed repeatedly but is logged at WARN once; the rest at DEBUG.
    const warns = m.warn.mock.calls.filter(([, msg]) => String(msg).startsWith("Rejected an API request"));
    expect(warns.length).toBeLessThanOrEqual(1);
    expect(m.debug).toHaveBeenCalled();
  });

  it("fails closed with 503 when the key lookup throws", async () => {
    m.findMany.mockRejectedValueOnce(new Error("db down"));
    const r = await authenticateApiKey(request({ "x-api-key": newApiKey() }), null);
    expect(r.ok === false && r.response.status).toBe(503);
    if (!r.ok) expect(await r.response.json()).toEqual({ error: "Authentication is temporarily unavailable" });
    expect(m.error).toHaveBeenCalledWith("API", "API key lookup failed", { error: "Error: db down" });
  });

  it("refuses a valid key over its request budget, warning once", async () => {
    const key = addKey("busy-key");
    storeOf(apiKeyRequestLimiter).delete("busy-key");
    apiKeyRequestLimiter.check("busy-key", apiKeyRequestLimiter.maxAttempts);
    const first = await authenticateApiKey(request({ "x-api-key": key }), null);
    const second = await authenticateApiKey(request({ "x-api-key": key }), null);
    for (const r of [first, second]) {
      expect(r.ok === false && r.response.status).toBe(429);
      if (!r.ok) expect(Number(r.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
    const warns = m.warn.mock.calls.filter(([, msg]) => String(msg).includes("went over"));
    expect(warns).toHaveLength(1);
    storeOf(apiKeyRequestLimiter).delete("busy-key");
  });
});

describe("remembered verifications", () => {
  it("re-verifies a key once its 15 idle minutes have passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const key = addKey("k1");
    expect((await authenticateApiKey(request({ "x-api-key": key }), null)).ok).toBe(true);
    expect((await authenticateApiKey(request({ "x-api-key": key }), null)).ok).toBe(true);
    expect(m.findMany).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:16:00Z"));
    clearFloors();
    expect((await authenticateApiKey(request({ "x-api-key": key }), null)).ok).toBe(true);
    // Looked up and verified again by prefix, not read by id.
    expect(m.findMany).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used key once 1,000 are remembered", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) keys.push(addKey(`k${i}`));
    for (const [i, key] of keys.entries()) {
      if (i % 90 === 0) clearFloors();
      expect((await authenticateApiKey(request({ "x-api-key": key }), null)).ok).toBe(true);
    }
    // Use the first key again so the second becomes the oldest.
    m.findMany.mockClear();
    expect((await authenticateApiKey(request({ "x-api-key": keys[0] }), null)).ok).toBe(true);
    expect(m.findMany).not.toHaveBeenCalled();

    clearFloors();
    const extra = addKey("k-extra");
    expect((await authenticateApiKey(request({ "x-api-key": extra }), null)).ok).toBe(true);

    m.findMany.mockClear();
    // The oldest (keys[1]) was forgotten and is verified again…
    expect((await authenticateApiKey(request({ "x-api-key": keys[1] }), null)).ok).toBe(true);
    expect(m.findMany).toHaveBeenCalledTimes(1);
    // …while the recently used first key is still remembered.
    m.findMany.mockClear();
    expect((await authenticateApiKey(request({ "x-api-key": keys[0] }), null)).ok).toBe(true);
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("sweeps expired entries before evicting a live one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) keys.push(addKey(`k${i}`));
    for (const [i, key] of keys.entries()) {
      if (i % 90 === 0) clearFloors();
      expect((await authenticateApiKey(request({ "x-api-key": key }), null)).ok).toBe(true);
    }
    vi.setSystemTime(new Date("2026-01-01T00:20:00Z"));
    clearFloors();
    const fresh = addKey("fresh");
    expect((await authenticateApiKey(request({ "x-api-key": fresh }), null)).ok).toBe(true);
    m.findMany.mockClear();
    expect((await authenticateApiKey(request({ "x-api-key": fresh }), null)).ok).toBe(true);
    expect(m.findMany).not.toHaveBeenCalled();
  });
});

describe("withApiKey response handling", () => {
  it("downgrades a handler's public Cache-Control to private", async () => {
    const key = addKey("k1");
    const handler = withApiKey("media:read", async () =>
      NextResponse.json({}, { headers: { "Cache-Control": "Public, max-age=3600" } }),
    );
    const res = await handler(request({ "x-api-key": key }));
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("sets no-store where the handler set nothing, and audits a write at INFO", async () => {
    const key = addKey("k1", ["media:read", "streams:write"]);
    const handler = withApiKey("streams:write", async () => new Response(null, { status: 204 }));
    const res = await handler(request({ "x-api-key": key }, "POST", "http://localhost/api/v1/tools/maintenance"));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(m.info).toHaveBeenCalledWith(
      "API",
      expect.stringMatching(/^POST \/api\/v1\/tools\/maintenance → 204 \(API key "Key k1"/),
    );
  });

  it("audits a handler that throws as an error and rethrows", async () => {
    const key = addKey("k1", ["media:read", "streams:write"]);
    const handler = withApiKey("streams:write", async () => {
      throw new Error("boom");
    });
    await expect(handler(request({ "x-api-key": key }, "DELETE"))).rejects.toThrow("boom");
    expect(m.info).toHaveBeenCalledWith("API", expect.stringContaining("→ error"));
  });
});
