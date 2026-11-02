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
import { GET, PUT } from "@/app/api/settings/dedup/route";
import { appCache } from "@/lib/cache/memory-cache";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

const prisma = getTestPrisma();
const storedDedup = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.dedupStats;

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/dedup
// ---------------------------------------------------------------------------
describe("GET /api/settings/dedup", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default dedupStats (true) when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
  });

  it("returns the saved dedupStats", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await prisma.appSettings.create({ data: { userId: user.id, dedupStats: false } });

    const res = await callRoute(GET);
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/dedup
// ---------------------------------------------------------------------------
describe("PUT /api/settings/dedup", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: false },
    });
    await expectJson(res, 401);
  });

  it("saves dedupStats as true", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: true },
    });
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
    expect(await storedDedup(user.id)).toBe(true);
  });

  it("saves dedupStats as false", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: false },
    });
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);
    expect(await storedDedup(user.id)).toBe(false);
  });

  // Every listing renders the canonical copy or every copy depending on the
  // toggle: the cached figures are dropped and open pages told to refetch.
  it("drops the media caches and tells open pages to refetch", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    appCache.set("stats:test-entry", { totalItems: 1 });
    const events: AppEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    try {
      await expectJson(await callRoute(PUT, { method: "PUT", body: { dedupStats: false } }));
    } finally {
      unsubscribe();
    }
    expect(appCache.get("stats:test-entry")).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ type: "sync:completed", userId: user.id, meta: { dedupStats: false } }),
    ]);
  });

  it("returns 400 when dedupStats is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(await storedDedup(user.id)).toBeUndefined();
  });

  it("returns 400 when dedupStats is not a boolean", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: "yes" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["dedupStats: Invalid input: expected boolean, received string"]);
    expect(await storedDedup(user.id)).toBeUndefined();
  });

  it("toggles dedupStats back and forth", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    // Set to false
    await expectJson(await callRoute(PUT, { method: "PUT", body: { dedupStats: false } }));

    // Verify it's false
    let res = await callRoute(GET);
    let body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);

    // Set back to true
    await expectJson(await callRoute(PUT, { method: "PUT", body: { dedupStats: true } }));

    // Verify it's true
    res = await callRoute(GET);
    body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
  });
});
