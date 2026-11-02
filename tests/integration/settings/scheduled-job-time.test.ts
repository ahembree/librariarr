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

import { PUT } from "@/app/api/settings/scheduled-job-time/route";

describe("PUT /api/settings/scheduled-job-time", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, { method: "PUT", body: { scheduledJobTime: "03:30" } });
    await expectJson(res, 401);
  });

  it("saves the time, creating the settings row when none exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, { method: "PUT", body: { scheduledJobTime: "03:30" } });
    const body = await expectJson<{ scheduledJobTime: string }>(res);
    expect(body).toEqual({ scheduledJobTime: "03:30" });

    const stored = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(stored?.scheduledJobTime).toBe("03:30");
  });

  it("updates an existing time", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    await getTestPrisma().appSettings.create({ data: { userId: user.id, scheduledJobTime: "03:30" } });
    const res = await callRoute(PUT, { method: "PUT", body: { scheduledJobTime: "22:15" } });
    expect((await expectJson<{ scheduledJobTime: string }>(res)).scheduledJobTime).toBe("22:15");
    const stored = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(stored?.scheduledJobTime).toBe("22:15");
  });

  it.each(["24:00", "9:00", "12:60", "noon"])("rejects %s with 400", async (value) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, { method: "PUT", body: { scheduledJobTime: value } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["scheduledJobTime: Must be in HH:MM format (24-hour)"]);
    expect(await getTestPrisma().appSettings.count()).toBe(0);
  });
});
