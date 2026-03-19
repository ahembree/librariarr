import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lastScheduledLifecycleDetection: unknown;
      lifecycleExecutionSchedule: string;
      lastScheduledLifecycleExecution: unknown;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBeDefined();
    expect(body.lifecycleExecutionSchedule).toBeDefined();
  });

  it("returns saved schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "DAILY" },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{ lifecycleDetectionSchedule: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("DAILY");
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "EVERY_6H" },
    });
    const body = await expectJson<{ lifecycleDetectionSchedule: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("EVERY_6H");
  });

  it("updates execution schedule with preset value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "WEEKLY" },
    });
    const body = await expectJson<{ lifecycleExecutionSchedule: string }>(res);
    expect(body.lifecycleExecutionSchedule).toBe("WEEKLY");
  });

  it("updates both schedules at once", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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

  it("accepts valid cron expression", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "0 */4 * * *" },
    });
    const body = await expectJson<{ lifecycleDetectionSchedule: string }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("0 */4 * * *");
  });

  it("returns 400 for invalid detection schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "INVALID_PRESET" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid detection schedule");
  });

  it("returns 400 for invalid execution schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "not-a-cron" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid execution schedule");
  });

  it("returns 400 when no schedule is provided", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("No schedule provided");
  });
});
