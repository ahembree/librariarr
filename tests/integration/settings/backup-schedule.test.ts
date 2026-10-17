import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
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

// Import AFTER mocks
import { GET, PUT } from "@/app/api/settings/backup-schedule/route";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/backup-schedule
// ---------------------------------------------------------------------------
describe("GET /api/settings/backup-schedule", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns current backup schedule settings", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        backupSchedule: "DAILY",
        backupRetentionCount: 10,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson(res);
    // Exactly the schedule fields: never the rest of the settings row (the
    // backup passphrase lives there too).
    expect(body).toEqual({ backupSchedule: "DAILY", backupRetentionCount: 10, lastBackupAt: null });
  });

  it("returns the defaults, creating the settings row, when none exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const body = await expectJson(await callRoute(GET));
    expect(body).toEqual({ backupSchedule: "DAILY", backupRetentionCount: 7, lastBackupAt: null });
    expect(await prisma.appSettings.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/backup-schedule
// ---------------------------------------------------------------------------
describe("PUT /api/settings/backup-schedule", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "DAILY" },
    });
    await expectJson(res, 401);
  });

  it("returns 400 on invalid schedule string", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "NOT_A_SCHEDULE" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
    expect(await prisma.appSettings.count()).toBe(0);
  });

  it("returns 400 for a cron expression the dispatcher cannot evaluate", async () => {
    // node-cron accepts a wrap-around range; cron-parser, which the dispatcher
    // runs, does not — so it used to save and backups then never ran.
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "0 22-2 * * *" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
    expect(await prisma.appSettings.count()).toBe(0);
  });

  it("accepts a cron expression the dispatcher can evaluate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "30 3 * * 1" },
    });
    const body = await expectJson<{ backupSchedule: string }>(res);
    expect(body.backupSchedule).toBe("30 3 * * 1");
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.backupSchedule).toBe("30 3 * * 1");
  });

  it.each([0, 101])("returns 400 for a retention count of %d", async (backupRetentionCount) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(PUT, { method: "PUT", body: { backupRetentionCount } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^backupRetentionCount: /);
    expect(await prisma.appSettings.count()).toBe(0);
  });

  it("updates backup schedule settings", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "WEEKLY", backupRetentionCount: 5 },
    });
    const body = await expectJson<{
      backupSchedule: string;
      backupRetentionCount: number;
    }>(res);
    expect(body.backupSchedule).toBe("WEEKLY");
    expect(body.backupRetentionCount).toBe(5);
    const stored = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(stored?.backupSchedule).toBe("WEEKLY");
    expect(stored?.backupRetentionCount).toBe(5);
  });

  it("changes only the fields it is sent", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, backupSchedule: "DAILY", backupRetentionCount: 10 },
    });
    setMockSession({ isLoggedIn: true, userId: user.id});

    await expectJson(await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "EVERY_12H" },
    }));

    const res = await callRoute(GET);
    const body = await expectJson<{ backupSchedule: string; backupRetentionCount: number }>(res);
    expect(body.backupSchedule).toBe("EVERY_12H");
    expect(body.backupRetentionCount).toBe(10);
  });
});
