import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { callV1, type V1CallOptions, type V1RouteHandler } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));
vi.mock("@/lib/lifecycle/collections", () => ({
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));

import { GET as rulesGET } from "@/app/api/v1/lifecycle/rules/route";
import { GET as matchesGET } from "@/app/api/v1/lifecycle/matches/route";
import { GET as actionsGET } from "@/app/api/v1/lifecycle/actions/route";
import {
  GET as exceptionsGET,
  POST as exceptionsPOST,
} from "@/app/api/v1/lifecycle/exceptions/route";
import { DELETE as exceptionDELETE } from "@/app/api/v1/lifecycle/exceptions/[id]/route";
import { POST as runPOST } from "@/app/api/v1/lifecycle/run/route";
import { POST as syncPOST } from "@/app/api/v1/sync/route";
import { GET as syncStatusGET } from "@/app/api/v1/sync/status/route";
import { GET as systemInfoGET } from "@/app/api/v1/system/info/route";

/**
 * The auth posture of the whole v1 *operations* surface, asserted from one
 * table. (The library/read surface has its own table in `auth-matrix.test.ts`.)
 * A new ops endpoint that skips `withApiKey`, or a write endpoint that forgets
 * `{ scope: "READ_WRITE" }`, is caught by adding its row here.
 */

interface Seed {
  userId: string;
  serverId: string;
  /** A media item with no exception yet — the POST target. */
  freeMediaItemId: string;
  /** An existing exception row — the DELETE target. */
  exceptionId: string;
}

interface OpsRoute {
  name: string;
  handler: V1RouteHandler;
  /** True for routes declared `{ scope: "READ_WRITE" }`. */
  write: boolean;
  /** Status a correctly scoped key gets against the seeded fixture. */
  ok: number;
  /** Per-route request shape; the seed supplies the ids a write route needs. */
  request: (seed: Seed) => V1CallOptions;
}

const OPS_ROUTES: OpsRoute[] = [
  {
    name: "GET /api/v1/lifecycle/rules",
    handler: rulesGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/lifecycle/rules" }),
  },
  {
    name: "GET /api/v1/lifecycle/matches",
    handler: matchesGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/lifecycle/matches" }),
  },
  {
    name: "GET /api/v1/lifecycle/actions",
    handler: actionsGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/lifecycle/actions" }),
  },
  {
    name: "GET /api/v1/lifecycle/exceptions",
    handler: exceptionsGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/lifecycle/exceptions" }),
  },
  {
    name: "POST /api/v1/lifecycle/exceptions",
    handler: exceptionsPOST,
    write: true,
    ok: 201,
    request: (seed) => ({
      url: "/api/v1/lifecycle/exceptions",
      method: "POST",
      body: { mediaItemId: seed.freeMediaItemId },
    }),
  },
  {
    name: "DELETE /api/v1/lifecycle/exceptions/[id]",
    handler: exceptionDELETE,
    write: true,
    ok: 200,
    request: (seed) => ({
      url: `/api/v1/lifecycle/exceptions/${seed.exceptionId}`,
      method: "DELETE",
      params: { id: seed.exceptionId },
    }),
  },
  {
    name: "POST /api/v1/lifecycle/run",
    handler: runPOST,
    write: true,
    ok: 200,
    request: () => ({
      url: "/api/v1/lifecycle/run",
      method: "POST",
      body: { mode: "detection" },
    }),
  },
  {
    name: "POST /api/v1/sync",
    handler: syncPOST,
    write: true,
    ok: 200,
    request: () => ({ url: "/api/v1/sync", method: "POST", body: {} }),
  },
  {
    name: "GET /api/v1/sync/status",
    handler: syncStatusGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/sync/status" }),
  },
  {
    name: "GET /api/v1/system/info",
    handler: systemInfoGET,
    write: false,
    ok: 200,
    request: () => ({ url: "/api/v1/system/info" }),
  },
];

const WRITE_ROUTES = OPS_ROUTES.filter((r) => r.write);
const READ_ROUTES = OPS_ROUTES.filter((r) => !r.write);

const PAST = new Date(Date.now() - 60_000);

async function seedFixture(): Promise<Seed> {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id);
  const free = await createTestMediaItem(library.id, { title: "Unprotected" });
  const guarded = await createTestMediaItem(library.id, { title: "Protected" });
  const exception = await getTestPrisma().lifecycleException.create({
    data: { userId: user.id, mediaItemId: guarded.id, reason: "keep" },
  });
  return {
    userId: user.id,
    serverId: server.id,
    freeMediaItemId: free.id,
    exceptionId: exception.id,
  };
}

function call(route: OpsRoute, seed: Seed, extra: Partial<V1CallOptions> = {}) {
  return callV1(route.handler, { ...route.request(seed), ...extra });
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(true);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("/api/v1 ops — key authentication", () => {
  it.each(OPS_ROUTES)("$name rejects a request with no key at all", async (route) => {
    const seed = await seedFixture();
    const body = await expectJson<{ error: string }>(await call(route, seed), 401);
    expect(body.error).toContain("Missing API key");
  });

  it.each(OPS_ROUTES)("$name rejects a garbage key", async (route) => {
    const seed = await seedFixture();
    const body = await expectJson<{ error: string }>(
      await call(route, seed, { key: "lbr_not-a-real-key" }),
      401,
    );
    expect(body.error).toBe("Invalid API key.");
  });

  it.each(OPS_ROUTES)("$name rejects a revoked key", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, {
      scope: "READ_WRITE",
      revokedAt: PAST,
    });
    const body = await expectJson<{ error: string }>(
      await call(route, seed, { key: raw }),
      401,
    );
    expect(body.error).toBe("This API key has been revoked.");
  });

  it.each(OPS_ROUTES)("$name rejects an expired key", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, {
      scope: "READ_WRITE",
      expiresAt: PAST,
    });
    const body = await expectJson<{ error: string }>(
      await call(route, seed, { key: raw }),
      401,
    );
    expect(body.error).toBe("This API key has expired.");
  });

  // A v1 route that answered a session-authenticated request would let the web
  // UI's cookie reach the public surface — which would mean it never went
  // through withApiKey at all.
  it.each(OPS_ROUTES)("$name ignores a logged-in session with no key", async (route) => {
    const seed = await seedFixture();
    setMockSession({ isLoggedIn: true, userId: seed.userId, plexToken: "tok" });
    await expectJson(await call(route, seed), 401);
  });

  it.each(OPS_ROUTES)("$name authenticates via both header forms", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_WRITE" });

    // Only "did the credential get through" is asserted here: replaying a write
    // legitimately answers 409/404 the second time, and neither is a 401.
    expect((await call(route, seed, { key: raw })).status).not.toBe(401);
    expect((await call(route, seed, { key: raw, bearer: true })).status).not.toBe(401);
  });
});

describe("/api/v1 ops — scope enforcement", () => {
  // The load-bearing assertion of this suite: a write route that forgot
  // `{ scope: "READ_WRITE" }` would answer 2xx to a read-only key.
  it.each(WRITE_ROUTES)("$name rejects a READ_ONLY key with 403", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_ONLY" });
    const body = await expectJson<{ error: string }>(
      await call(route, seed, { key: raw }),
      403,
    );
    expect(body.error).toBe(
      "This API key is read-only and cannot perform write operations.",
    );
  });

  it.each(WRITE_ROUTES)("$name succeeds with a READ_WRITE key", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_WRITE" });
    expect((await call(route, seed, { key: raw })).status).toBe(route.ok);
  });

  it.each(READ_ROUTES)("$name accepts a READ_ONLY key", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_ONLY" });
    expect((await call(route, seed, { key: raw })).status).toBe(route.ok);
  });

  it.each(READ_ROUTES)("$name accepts a READ_WRITE key", async (route) => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_WRITE" });
    expect((await call(route, seed, { key: raw })).status).toBe(route.ok);
  });
});

describe("/api/v1 ops — key bookkeeping", () => {
  it("stamps lastUsedAt on a successful call", async () => {
    const seed = await seedFixture();
    const { apiKey, raw } = await createTestApiKey(seed.userId, { scope: "READ_ONLY" });
    expect(apiKey.lastUsedAt).toBeNull();

    await expectJson(
      await callV1(systemInfoGET, { url: "/api/v1/system/info", key: raw }),
      200,
    );

    // The touch is throttled and fire-and-forget, so it lands after the response
    // has already been returned — poll rather than read once. If this ever turns
    // flaky, the load-bearing half is the 200 above; drop the poll, not the test.
    let stamped: Date | null = null;
    for (let attempt = 0; attempt < 40 && stamped === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const row = await getTestPrisma().apiKey.findUnique({ where: { id: apiKey.id } });
      stamped = row?.lastUsedAt ?? null;
    }
    expect(stamped).not.toBeNull();
  });

  it("stops accepting a key once its owner is gone", async () => {
    const seed = await seedFixture();
    const { raw } = await createTestApiKey(seed.userId, { scope: "READ_WRITE" });
    await getTestPrisma().user.delete({ where: { id: seed.userId } });

    await expectJson(
      await callV1(systemInfoGET, { url: "/api/v1/system/info", key: raw }),
      401,
    );
  });
});
