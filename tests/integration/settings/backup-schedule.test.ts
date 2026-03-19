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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{
      backupSchedule: string;
      backupRetentionCount: number;
      lastBackupAt: string | null;
    }>(res);
    expect(body.backupSchedule).toBe("DAILY");
    expect(body.backupRetentionCount).toBe(10);
    expect(body.lastBackupAt).toBeNull();
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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "NOT_A_SCHEDULE" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
  });

  it("updates backup schedule settings", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
  });

  it("returns updated schedule after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, {
      method: "PUT",
      body: { backupSchedule: "EVERY_12H" },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{ backupSchedule: string }>(res);
    expect(body.backupSchedule).toBe("EVERY_12H");
  });
});
