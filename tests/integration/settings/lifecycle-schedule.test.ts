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

import { GET, PUT } from "@/app/api/settings/lifecycle-schedule/route";

const prisma = getTestPrisma();
const storedSettings = (userId: string) => prisma.appSettings.findUnique({ where: { userId } });

describe("GET /api/settings/lifecycle-schedule", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default schedule values when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson(res);
    expect(body).toEqual({
      lifecycleDetectionSchedule: "EVERY_6H",
      lastScheduledLifecycleDetection: null,
      lifecycleExecutionSchedule: "EVERY_6H",
      lastScheduledLifecycleExecution: null,
    });
    // The settings row is created on first read.
    expect(await storedSettings(user.id)).not.toBeNull();
  });

  it("returns saved schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const lastRun = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.appSettings.create({
      data: { userId: user.id, lifecycleDetectionSchedule: "DAILY", lastScheduledLifecycleDetection: lastRun },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{ lifecycleDetectionSchedule: string; lastScheduledLifecycleDetection: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("DAILY");
    expect(body.lastScheduledLifecycleDetection).toBe(lastRun.toISOString());
  });
});

describe("PUT /api/settings/lifecycle-schedule", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "DAILY" },
    });
    await expectJson(res, 401);
  });

  it("updates detection schedule with preset value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "EVERY_12H" },
    });
    const body = await expectJson<{ lifecycleDetectionSchedule: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("EVERY_12H");
    expect((await storedSettings(user.id))?.lifecycleDetectionSchedule).toBe("EVERY_12H");
  });

  it("updates execution schedule with preset value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "WEEKLY" },
    });
    const body = await expectJson<{ lifecycleExecutionSchedule: string }>(res);
    expect(body.lifecycleExecutionSchedule).toBe("WEEKLY");
    const stored = await storedSettings(user.id);
    expect(stored?.lifecycleExecutionSchedule).toBe("WEEKLY");
    // The other schedule is left as it was.
    expect(stored?.lifecycleDetectionSchedule).toBe("EVERY_6H");
  });

  it("updates both schedules at once", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {
        lifecycleDetectionSchedule: "EVERY_12H",
        lifecycleExecutionSchedule: "DAILY",
      },
    });
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("EVERY_12H");
    expect(body.lifecycleExecutionSchedule).toBe("DAILY");
  });

  it("accepts MANUAL for both schedules", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "MANUAL", lifecycleExecutionSchedule: "MANUAL" },
    }));

    const body = await expectJson<{ lifecycleDetectionSchedule: string; lifecycleExecutionSchedule: string }>(
      await callRoute(GET),
    );
    expect(body.lifecycleDetectionSchedule).toBe("MANUAL");
    expect(body.lifecycleExecutionSchedule).toBe("MANUAL");
  });

  it("accepts valid cron expression", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "0 */4 * * *" },
    });
    const body = await expectJson<{ lifecycleDetectionSchedule: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("0 */4 * * *");
  });

  it("returns 400 for invalid detection schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "INVALID_PRESET" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid detection schedule");
    expect(await storedSettings(user.id)).toBeNull();
  });

  it("writes neither schedule when one of the two is invalid", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "DAILY", lifecycleExecutionSchedule: "not-a-cron" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid execution schedule");
    expect(await storedSettings(user.id)).toBeNull();
  });

  it("returns 400 for invalid execution schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "not-a-cron" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid execution schedule");
    expect(await storedSettings(user.id)).toBeNull();
  });

  it("returns 400 for a cron expression the dispatcher cannot evaluate", async () => {
    // node-cron accepts these; cron-parser, which the dispatcher runs, does not
    // (a wrap-around range) or reads them as no cron does (`H` is random) —
    // they used to save and then never run, or run at a random minute.
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    for (const lifecycleExecutionSchedule of ["0 22-2 * * *", "0 3 * * FRI-MON", "H * * * *"]) {
      const res = await callRoute(PUT, { method: "PUT", body: { lifecycleExecutionSchedule } });
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain("Invalid execution schedule");
    }
    expect(await storedSettings(user.id)).toBeNull();
  });

  it("returns 400 when no schedule is provided", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("No schedule provided");
  });
});
