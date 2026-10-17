import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/lifecycle/stats/reset/route";

describe("POST /api/lifecycle/stats/reset", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth and writes nothing", async () => {
    const res = await POST();
    const body = await expectJson<{ error: string }>(res, 401);
    expect(body.error).toBe("Unauthorized");
    expect(await getTestPrisma().appSettings.count()).toBe(0);
  });

  it("creates the settings row with the reset time when none exists", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const before = Date.now();
    const body = await expectJson<{ resetAt: string }>(await POST(), 200);
    const after = Date.now();

    const resetAt = new Date(body.resetAt).getTime();
    expect(resetAt).toBeGreaterThanOrEqual(before);
    expect(resetAt).toBeLessThanOrEqual(after);

    const row = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.deletionStatsResetAt?.toISOString()).toBe(body.resetAt);
  });

  it("moves an existing reset time forward without touching other settings", async () => {
    const user = await createTestUser();
    const prisma = getTestPrisma();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        deletionStatsResetAt: new Date("2020-01-01T00:00:00Z"),
        maxAutoDeleteItems: 42,
      },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const before = Date.now();
    const body = await expectJson<{ resetAt: string }>(await POST(), 200);
    const after = Date.now();
    const row = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(row?.deletionStatsResetAt?.toISOString()).toBe(body.resetAt);
    expect(row!.deletionStatsResetAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.deletionStatsResetAt!.getTime()).toBeLessThanOrEqual(after);
    expect(row?.maxAutoDeleteItems).toBe(42);
  });
});
