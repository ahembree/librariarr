import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { createTestUser, createTestApiKey } from "../../setup/test-helpers";
import { callV1, type V1RouteHandler } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as healthGET } from "@/app/api/v1/health/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { GET as serversGET } from "@/app/api/v1/servers/route";
import { GET as librariesGET } from "@/app/api/v1/libraries/route";
import { GET as statsGET } from "@/app/api/v1/stats/route";
import { GET as moviesGET } from "@/app/api/v1/library/movies/route";
import { GET as seriesGET } from "@/app/api/v1/library/series/route";
import { GET as episodesGET } from "@/app/api/v1/library/episodes/route";
import { GET as musicGET } from "@/app/api/v1/library/music/route";
import { GET as searchGET } from "@/app/api/v1/library/search/route";
import { GET as itemGET } from "@/app/api/v1/library/items/[id]/route";

interface V1Route {
  name: string;
  handler: V1RouteHandler;
  url: string;
  searchParams?: Record<string, string>;
  params?: Record<string, string>;
}

/**
 * Every authenticated route on the v1-library surface. A new endpoint that
 * forgets to go through `withApiKey` is caught by adding its row here — the
 * rejection cases below are asserted against the whole table, so no endpoint
 * can quietly ship without them.
 */
const V1_ROUTES: V1Route[] = [
  { name: "GET /api/v1/me", handler: meGET, url: "/api/v1/me" },
  { name: "GET /api/v1/servers", handler: serversGET, url: "/api/v1/servers" },
  { name: "GET /api/v1/libraries", handler: librariesGET, url: "/api/v1/libraries" },
  { name: "GET /api/v1/stats", handler: statsGET, url: "/api/v1/stats" },
  { name: "GET /api/v1/library/movies", handler: moviesGET, url: "/api/v1/library/movies" },
  { name: "GET /api/v1/library/series", handler: seriesGET, url: "/api/v1/library/series" },
  { name: "GET /api/v1/library/episodes", handler: episodesGET, url: "/api/v1/library/episodes" },
  { name: "GET /api/v1/library/music", handler: musicGET, url: "/api/v1/library/music" },
  {
    name: "GET /api/v1/library/search",
    handler: searchGET,
    url: "/api/v1/library/search",
    searchParams: { q: "matrix" },
  },
  {
    name: "GET /api/v1/library/items/[id]",
    handler: itemGET,
    url: "/api/v1/library/items/abc",
    params: { id: "abc" },
  },
];

const PAST = new Date(Date.now() - 60_000);

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("/api/v1 authentication matrix", () => {
  it.each(V1_ROUTES)("$name rejects a request with no key", async (route) => {
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Missing API key");
  });

  it.each(V1_ROUTES)("$name rejects an unknown key", async (route) => {
    await createTestUser();
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: "lbr_not-a-real-key",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid API key.");
  });

  it.each(V1_ROUTES)("$name rejects a revoked key", async (route) => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { revokedAt: PAST });
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: raw,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("This API key has been revoked.");
  });

  it.each(V1_ROUTES)("$name rejects an expired key", async (route) => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { expiresAt: PAST });
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: raw,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("This API key has expired.");
  });

  it.each(V1_ROUTES)("$name does not accept a logged-in session in place of a key", async (route) => {
    const user = await createTestUser();
    // A v1 route that answered this would be reachable from any browser that
    // holds a UI session cookie, which is exactly what the key surface avoids.
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
    });
    expect(response.status).toBe(401);
  });

  it.each(V1_ROUTES)("$name accepts a READ_ONLY key", async (route) => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { scope: "READ_ONLY" });
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: raw,
    });
    // Every route in this slice reads; a 403 here means one of them wrongly
    // declared `{ scope: "READ_WRITE" }`.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it.each(V1_ROUTES)("$name accepts a READ_WRITE key", async (route) => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { scope: "READ_WRITE" });
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: raw,
    });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it.each(V1_ROUTES)("$name accepts the key as an Authorization: Bearer header", async (route) => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const response = await callV1(route.handler, {
      url: route.url,
      searchParams: route.searchParams,
      params: route.params,
      key: raw,
      bearer: true,
    });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("rejects a key that expires exactly now", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id, { expiresAt: new Date() });
    const response = await callV1(meGET, { url: "/api/v1/me", key: raw });
    expect(response.status).toBe(401);
  });

  it("prefers X-Api-Key when both headers are present", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const response = await callV1(meGET, {
      url: "/api/v1/me",
      key: raw,
      headers: { Authorization: "Bearer lbr_garbage" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a key presented in the query string", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const response = await callV1(meGET, {
      url: "/api/v1/me",
      searchParams: { apiKey: raw },
    });
    expect(response.status).toBe(401);
  });

  it("health is the only route reachable without a key", async () => {
    const response = await healthGET();
    expect(response.status).toBe(200);
  });

  it("rate limits a single key past its per-minute budget", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    // The limiter allows 120 requests per key per minute; the 121st is refused.
    for (let i = 0; i < 120; i++) {
      const ok = await callV1(meGET, { url: "/api/v1/me", key: raw });
      expect(ok.status).toBe(200);
    }

    const limited = await callV1(meGET, { url: "/api/v1/me", key: raw });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toContain("Rate limit exceeded");
  });

  it("buckets the rate limit per key, not globally", async () => {
    const user = await createTestUser();
    const exhausted = await createTestApiKey(user.id, { name: "busy" });
    const fresh = await createTestApiKey(user.id, { name: "quiet" });

    for (let i = 0; i < 121; i++) {
      await callV1(meGET, { url: "/api/v1/me", key: exhausted.raw });
    }
    expect((await callV1(meGET, { url: "/api/v1/me", key: exhausted.raw })).status).toBe(429);
    expect((await callV1(meGET, { url: "/api/v1/me", key: fresh.raw })).status).toBe(200);
  });
});
