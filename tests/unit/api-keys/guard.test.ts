import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { apiKey: { findUnique: m.findUnique, updateMany: m.updateMany } },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { debug: m.debug, info: m.info, warn: m.warn, error: vi.fn() },
}));

import {
  FULL_LISTING_REQUEST_COST,
  authenticateApiKey,
  getApiKeyGuard,
  withApiKey,
} from "@/lib/api-keys/guard";
import { generateApiKey, hashApiKey } from "@/lib/api-keys/keys";
import { apiKeyRequestLimiter, apiKeyUnknownLookupFloor } from "@/lib/rate-limit/rate-limiter";
import { getApiKeyPrincipal } from "@/lib/api-keys/principal";
import type { ApiScope } from "@/lib/api-keys/scopes";

let ipCounter = 0;
function request(
  headers: Record<string, string> = {},
  url = "http://localhost/api/v1/me",
  method = "GET",
) {
  return new NextRequest(url, {
    method,
    headers: { "x-forwarded-for": `172.16.0.${++ipCounter}`, ...headers },
  });
}

function storedKey(overrides: Partial<{ scopes: string[]; expiresAt: Date | null; lastUsedAt: Date | null }> = {}) {
  const generated = generateApiKey();
  m.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) =>
    where.keyHash === generated.keyHash
      ? {
          id: "key-1",
          userId: "user-1",
          name: "Dashboard",
          prefix: generated.prefix,
          scopes: ["media:read"],
          expiresAt: null,
          lastUsedAt: null,
          ...overrides,
        }
      : null,
  );
  return generated.key;
}

describe("withApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("refuses an unknown scope when the route is defined", () => {
    expect(() => withApiKey("media:write" as ApiScope, async () => new Response())).toThrow(/Unknown API scope/);
  });

  it("marks the handler with its scope, and nothing else is marked", () => {
    expect(getApiKeyGuard(withApiKey("lifecycle:read", async () => new Response()))).toEqual({
      scope: "lifecycle:read",
    });
    expect(getApiKeyGuard(withApiKey(null, async () => new Response()))).toEqual({ scope: null });
    expect(getApiKeyGuard(async () => new Response())).toBeUndefined();
    expect(getApiKeyGuard("GET")).toBeUndefined();
  });

  it("does not run the handler for an unauthenticated request", async () => {
    const handler = vi.fn(async () => NextResponse.json({}));
    const res = await withApiKey("media:read", handler)(request());
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler under the key's principal and passes the route context through", async () => {
    const key = storedKey();
    const context = { params: Promise.resolve({ id: "abc" }) };
    const handler = vi.fn(async (_req: NextRequest, ctx: typeof context) => {
      const principal = getApiKeyPrincipal();
      return NextResponse.json({ keyId: principal?.keyId, id: (await ctx.params).id });
    });
    const res = await withApiKey("media:read", handler)(request({ authorization: `Bearer ${key}` }), context);
    expect(await res.json()).toEqual({ keyId: "key-1", id: "abc" });
    expect(getApiKeyPrincipal()).toBeUndefined();
  });
});

describe("withApiKey — response handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns a response with immutable headers untouched instead of failing", async () => {
    const key = storedKey();
    const handler = withApiKey("media:read", async () => Response.redirect("http://localhost/elsewhere", 302));
    const res = await handler(request({ "x-api-key": key }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/elsewhere");
  });

  it("keeps a handler's own non-public Cache-Control", async () => {
    const key = storedKey();
    const handler = withApiKey("media:read", async () =>
      NextResponse.json({}, { headers: { "Cache-Control": "private, max-age=60" } }),
    );
    const res = await handler(request({ "x-api-key": key }));
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
  });

  it("audits HEAD like GET — at DEBUG, not INFO", async () => {
    const key = storedKey();
    const handler = withApiKey("media:read", async () => new Response(null, { status: 200 }));
    await handler(request({ "x-api-key": key }, "http://localhost/api/v1/media/movies", "HEAD"));
    expect(m.debug).toHaveBeenCalledWith("API", expect.stringMatching(/^HEAD \/api\/v1\/media\/movies → 200/));
    expect(m.info).not.toHaveBeenCalled();
  });
});

describe("authenticateApiKey — keys in the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const key = generateApiKey().key;

  it.each([
    ["an upper-case parameter name", `?API_KEY=${key}`],
    ["a hyphenated parameter name", `?x-api-key=${key}`],
    ["any parameter holding a key", `?token=${key}`],
    ["a key as the parameter name", `?${key}`],
    ["a key among other parameters", `?limit=5&q=${encodeURIComponent(`find ${key} please`)}`],
    ["a key in the path", `/${key}`],
    ["a named parameter with no value", `?apikey=`],
    // The URL parser decodes once, so a doubly-encoded key reaches the check
    // as `lbr%5F…` — live, the one spelling that passed where every other
    // encoding was refused.
    ["a doubly-encoded key in a value", `?q=${encodeURIComponent(encodeURIComponent(key))}`],
    ["a doubly-encoded key as the parameter name", `?${encodeURIComponent(encodeURIComponent(key))}`],
    ["a doubly-encoded key in the path", `/${encodeURIComponent(encodeURIComponent(key))}`],
  ])("refuses %s with 400 and never looks the key up", async (_label, suffix) => {
    const url = suffix.startsWith("/")
      ? `http://localhost/api/v1/media${suffix}`
      : `http://localhost/api/v1/media/movies${suffix}`;
    const result = await authenticateApiKey(request({ authorization: `Bearer ${key}` }, url), null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(((await result.response.json()) as { error: string }).error).toMatch(/never in the URL/);
    }
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a short lbr_ value", "?q=lbr_short"],
    ["a longer run than a key", `?q=${key}X`],
    ["a key-like run inside a longer word", `?q=X${key}`],
    // A search term with a stray `%` is not valid percent-encoding; the
    // decode must hand the raw value back rather than throw.
    ["an undecodable value", "?q=100%25%zz"],
  ])("does not mistake %s for a key", async (_label, suffix) => {
    storedKey();
    const result = await authenticateApiKey(
      request({}, `http://localhost/api/v1/media/movies${suffix}`),
      null,
    );
    // No key in any header: the answer is "key required", not "key in URL".
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe("authenticateApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("looks the key up by its SHA-256, never by the key itself", async () => {
    const key = storedKey();
    const result = await authenticateApiKey(request({ "x-api-key": key }), "media:read");
    expect(result.ok).toBe(true);
    expect(m.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { keyHash: hashApiKey(key) } }));
    expect(JSON.stringify(m.findUnique.mock.calls)).not.toContain(key);
  });

  it("does not touch the database for a malformed key", async () => {
    const result = await authenticateApiKey(request({ authorization: "Bearer lbr_short" }), null);
    expect(result.ok).toBe(false);
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("trims a padded X-Api-Key and Bearer token", async () => {
    const key = storedKey();
    expect((await authenticateApiKey(request({ "x-api-key": `  ${key}  ` }), null)).ok).toBe(true);
    expect((await authenticateApiKey(request({ authorization: `Bearer   ${key}  ` }), null)).ok).toBe(true);
  });

  it("prefers the lbr_ key when the other header holds something else", async () => {
    const key = storedKey();
    const viaApiKeyHeader = await authenticateApiKey(
      request({ authorization: "Bearer some-proxy-jwt", "x-api-key": key }),
      null,
    );
    expect(viaApiKeyHeader.ok).toBe(true);
    const viaBearer = await authenticateApiKey(
      request({ authorization: `Bearer ${key}`, "x-api-key": "not-a-key" }),
      null,
    );
    expect(viaBearer.ok).toBe(true);
  });

  it("accepts the same key in both headers", async () => {
    const key = storedKey();
    const result = await authenticateApiKey(
      request({ authorization: `Bearer ${key}`, "x-api-key": key }),
      null,
    );
    expect(result.ok).toBe(true);
  });

  it("treats a key past its expiry instant as expired", async () => {
    const key = storedKey({ expiresAt: new Date(Date.now() - 1) });
    const result = await authenticateApiKey(request({ "x-api-key": key }), null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("skips the last-used write while the recorded use is under a minute old", async () => {
    const key = storedKey({ lastUsedAt: new Date(Date.now() - 10_000) });
    await authenticateApiKey(request({ "x-api-key": key }), null);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("still authenticates when recording the last use fails", async () => {
    const key = storedKey();
    m.updateMany.mockRejectedValueOnce(new Error("write failed"));
    const result = await authenticateApiKey(request({ "x-api-key": key }), null);
    expect(result.ok).toBe(true);
  });

  it("stores no address when the client address is unknown", async () => {
    const key = storedKey();
    const req = new NextRequest("http://localhost/api/v1/me", { headers: { "x-api-key": key } });
    await authenticateApiKey(req, null);
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastUsedIp: null }) }),
    );
  });

  it.each([
    ["an IPv4 address", "192.168.1.20", "192.168.1.20"],
    ["an IPv6 address", "2001:db8::1", "2001:db8::1"],
    ["a zoned IPv6 address", "fe80::1%eth0", "fe80::1%eth0"],
    ["free text posing as an address", "10.0.0.1 admin logged in", null],
    ["no address at all", undefined, null],
  ])("records %s as the last-used address only if it is an IP literal", async (_label, forwarded, stored) => {
    const key = storedKey();
    const headers: Record<string, string> = { "x-api-key": key };
    if (forwarded) headers["x-forwarded-for"] = forwarded;
    await authenticateApiKey(new NextRequest("http://localhost/api/v1/me", { headers }), null);
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastUsedIp: stored }) }),
    );
  });

  it("never writes a forged address into the log", async () => {
    storedKey();
    await authenticateApiKey(
      new NextRequest("http://localhost/api/v1/me", {
        headers: { "x-api-key": generateApiKey().key, "x-forwarded-for": "1.2.3.4 [FAKE] admin" },
      }),
      null,
    );
    const logged = JSON.stringify(m.warn.mock.calls);
    expect(logged).toContain("an unknown address");
    expect(logged).not.toContain("FAKE");
  });
});

describe("authenticateApiKey — unknown-key floor", () => {
  const floorStore = () => (apiKeyUnknownLookupFloor as unknown as { store: Map<string, unknown> }).store;

  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
    floorStore().clear();
  });

  afterEach(() => {
    floorStore().clear();
  });

  it("stops looking up keys nobody has used once a minute's worth of unknown ones went by — never a key in use", async () => {
    const active = generateApiKey();
    const idle = generateApiKey();
    const rowFor = (generated: ReturnType<typeof generateApiKey>) => ({
      id: `key-${generated.prefix}`,
      userId: "user-1",
      name: "Dashboard",
      prefix: generated.prefix,
      scopes: ["media:read"],
      expiresAt: null,
      lastUsedAt: new Date(),
    });
    m.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) =>
      where.keyHash === active.keyHash ? rowFor(active) : where.keyHash === idle.keyHash ? rowFor(idle) : null,
    );
    const auth = (key: string) => authenticateApiKey(request({ authorization: `Bearer ${key}` }), "media:read");

    // The active key authenticates once before the flood, so it is remembered.
    expect((await auth(active.key)).ok).toBe(true);

    const lookupsBefore = m.findUnique.mock.calls.length;
    for (let i = 0; i < apiKeyUnknownLookupFloor.maxAttempts; i++) {
      const res = await auth(generateApiKey().key);
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.response.status).toBe(401);
    }
    // Every one of those was a real lookup, and the budget's end was logged once.
    expect(m.findUnique.mock.calls.length).toBe(lookupsBefore + apiKeyUnknownLookupFloor.maxAttempts);
    const warnings = m.warn.mock.calls.filter(([, msg]) => String(msg).includes("unrecognised API keys"));
    expect(warnings).toHaveLength(1);

    // Past the floor: an unknown key is refused without a lookup…
    const lookupsAtFloor = m.findUnique.mock.calls.length;
    const refused = await auth(generateApiKey().key);
    expect(refused.ok === false && refused.response.status).toBe(429);
    // …and so is a valid key that has not been used lately (idle integrations
    // wait the minute out)…
    const idleRefused = await auth(idle.key);
    expect(idleRefused.ok === false && idleRefused.response.status).toBe(429);
    expect(m.findUnique.mock.calls.length).toBe(lookupsAtFloor);
    // …but the key in use is still looked up (so deleting it would still
    // revoke it) and still works.
    expect((await auth(active.key)).ok).toBe(true);
    expect(m.findUnique.mock.calls.length).toBe(lookupsAtFloor + 1);
    // A malformed key never reached the database before and still does not.
    const malformed = await auth("lbr_not-a-key");
    expect(malformed.ok === false && malformed.response.status).toBe(401);
    expect(m.findUnique.mock.calls.length).toBe(lookupsAtFloor + 1);

    // The minute passes.
    floorStore().clear();
    expect((await auth(idle.key)).ok).toBe(true);
  });
});

describe("authenticateApiKey — request cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("charges a limit=0 listing as several requests, everything else as one", async () => {
    const key = storedKey();
    const spy = vi.spyOn(apiKeyRequestLimiter, "check");
    try {
      await authenticateApiKey(request({ "x-api-key": key }, "http://localhost/api/v1/media/movies?limit=0"), "media:read");
      expect(spy).toHaveBeenLastCalledWith("key-1", FULL_LISTING_REQUEST_COST);
      await authenticateApiKey(request({ "x-api-key": key }, "http://localhost/api/v1/media/movies?limit=50"), "media:read");
      expect(spy).toHaveBeenLastCalledWith("key-1", 1);
      await authenticateApiKey(request({ "x-api-key": key }, "http://localhost/api/v1/media/movies"), "media:read");
      expect(spy).toHaveBeenLastCalledWith("key-1", 1);
      // Only reads page; a write carrying the parameter is still one request.
      await authenticateApiKey(
        request({ "x-api-key": key }, "http://localhost/api/v1/sync/cancel?limit=0", "POST"),
        "media:read",
      );
      expect(spy).toHaveBeenLastCalledWith("key-1", 1);
    } finally {
      spy.mockRestore();
    }
  });

  // The handlers `parseInt` the limit, so every spelling of zero they accept
  // is a full listing and must cost one. `0x` is the one that is NOT:
  // `parseInt("0x")` is NaN, and the handlers serve a default page for it.
  it.each([
    ["00", FULL_LISTING_REQUEST_COST],
    ["+0", FULL_LISTING_REQUEST_COST],
    ["-0", FULL_LISTING_REQUEST_COST],
    ["0.0", FULL_LISTING_REQUEST_COST],
    ["0e0", FULL_LISTING_REQUEST_COST],
    [" 0", FULL_LISTING_REQUEST_COST],
    ["0abc", FULL_LISTING_REQUEST_COST],
    ["0x0", FULL_LISTING_REQUEST_COST],
    ["0x", 1],
    ["1", 1],
    ["50", 1],
    ["abc", 1],
    ["", 1],
  ])("charges limit=%j the same as the handler reads it (%i)", async (raw, cost) => {
    const key = storedKey();
    const spy = vi.spyOn(apiKeyRequestLimiter, "check");
    try {
      const url = `http://localhost/api/v1/media/movies?limit=${encodeURIComponent(raw)}`;
      await authenticateApiKey(request({ "x-api-key": key }, url), "media:read");
      expect(spy).toHaveBeenLastCalledWith("key-1", cost);
    } finally {
      spy.mockRestore();
    }
  });

  it("charges a read with no limit as one request", async () => {
    const key = storedKey();
    const spy = vi.spyOn(apiKeyRequestLimiter, "check");
    try {
      await authenticateApiKey(request({ "x-api-key": key }, "http://localhost/api/v1/media/movies?page=2"), "media:read");
      expect(spy).toHaveBeenLastCalledWith("key-1", 1);
    } finally {
      spy.mockRestore();
    }
  });
});
