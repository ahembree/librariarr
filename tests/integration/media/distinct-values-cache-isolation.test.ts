/**
 * Multi-tenant isolation: the distinct-values response contains user-scoped
 * data (`matchedByRuleSet`, `watchedByUser`). Caching with a global key would
 * serve one user's PII to another. This suite uses the *real* in-memory cache
 * (no stub) and asserts:
 *   1. user B never sees user A's usernames after user A has populated the cache;
 *   2. user A's repeated request hits the cache (proving cache is on);
 *   3. invalidation via the prefix clears all per-user entries.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

// IMPORTANT: do NOT mock @/lib/cache/memory-cache — these tests exercise the
// real cache to verify per-user key isolation.

import { GET as MEDIA_GET } from "@/app/api/media/distinct-values/route";
import { GET as QUERY_GET } from "@/app/api/query/distinct-values/route";
import { appCache } from "@/lib/cache/memory-cache";

interface DistinctValuesResponse {
  watchedByUser: string[];
}

async function seedWatchUser(userId: string, username: string) {
  const { getTestPrisma } = await import("../../setup/test-db");
  const prisma = getTestPrisma();
  const server = await createTestServer(userId);
  const lib = await createTestLibrary(server.id);
  const item = await createTestMediaItem(lib.id, { title: `m-${username}`, type: "MOVIE" });
  await prisma.watchHistory.create({
    data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername: username },
  });
  return server.id;
}

describe.each([
  { name: "media distinct-values", GET: MEDIA_GET, url: "/api/media/distinct-values", prefix: "distinct-values:" },
  { name: "query distinct-values", GET: QUERY_GET, url: "/api/query/distinct-values", prefix: "query-distinct-values:" },
])("$name — per-user cache isolation", ({ GET, url, prefix }) => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    appCache.clear();
    await disconnectTestDb();
  });

  it("never serves user A's usernames to user B from cache", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    await seedWatchUser(userA.id, "alice");
    await seedWatchUser(userB.id, "bob");

    // User A primes the cache.
    setMockSession({ userId: userA.id, isLoggedIn: true });
    const aFirst = await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);
    expect(aFirst.watchedByUser).toEqual(["alice"]);

    // User B must NOT see alice from a stale cache entry.
    setMockSession({ userId: userB.id, isLoggedIn: true });
    const bResp = await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);
    expect(bResp.watchedByUser).toEqual(["bob"]);
    expect(bResp.watchedByUser).not.toContain("alice");
  });

  it("user A's second request hits the cache (asserts caching is on)", async () => {
    const userA = await createTestUser();
    await seedWatchUser(userA.id, "alice");

    setMockSession({ userId: userA.id, isLoggedIn: true });
    await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);

    // Mutate the DB directly so a non-cached path would see the new user;
    // a cache hit must return the original list only.
    const { getTestPrisma } = await import("../../setup/test-db");
    const prisma = getTestPrisma();
    const server = await prisma.mediaServer.findFirst({ where: { userId: userA.id } });
    const lib = await createTestLibrary(server!.id);
    const item = await createTestMediaItem(lib.id, { title: "post-cache", type: "MOVIE" });
    await prisma.watchHistory.create({
      data: { mediaItemId: item.id, mediaServerId: server!.id, serverUsername: "post-cache-user" },
    });

    const second = await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);
    expect(second.watchedByUser).toEqual(["alice"]);
    expect(second.watchedByUser).not.toContain("post-cache-user");
  });

  it("invalidatePrefix clears every per-user cache entry under the route's prefix", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    await seedWatchUser(userA.id, "alice");
    await seedWatchUser(userB.id, "bob");

    setMockSession({ userId: userA.id, isLoggedIn: true });
    await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);
    setMockSession({ userId: userB.id, isLoggedIn: true });
    await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);

    // Prefix invalidation (what sync/purge/server-change call) must wipe both.
    appCache.invalidatePrefix(prefix);

    // After invalidation, a fresh-data mutation must surface immediately.
    const { getTestPrisma } = await import("../../setup/test-db");
    const prisma = getTestPrisma();
    const serverA = await prisma.mediaServer.findFirst({ where: { userId: userA.id } });
    const libA = await createTestLibrary(serverA!.id);
    const itemA = await createTestMediaItem(libA.id, { title: "fresh", type: "MOVIE" });
    await prisma.watchHistory.create({
      data: { mediaItemId: itemA.id, mediaServerId: serverA!.id, serverUsername: "fresh-user" },
    });

    setMockSession({ userId: userA.id, isLoggedIn: true });
    const aAfter = await expectJson<DistinctValuesResponse>(await callRoute(GET, { url }), 200);
    expect(aAfter.watchedByUser).toContain("fresh-user");
  });
});
