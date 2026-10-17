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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  apiLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  dbLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import AFTER mocks
import {
  GET as getSyncSchedule,
  PUT as putSyncSchedule,
} from "@/app/api/settings/sync-schedule/route";
import { GET as getScheduleInfo } from "@/app/api/settings/schedule-info/route";
import { getSystemTimezone } from "@/lib/jobs/schedule";

// The lifecycle schedule, accent colour, chip colours, column preferences,
// dashboard layout and log retention routes each have their own file beside
// this one.

const prisma = getTestPrisma();
const storedSyncSchedule = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.syncSchedule;

/** Hour and minute of an instant on the server's own wall clock. */
function serverWallClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: getSystemTimezone(),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// /api/settings/sync-schedule
// ---------------------------------------------------------------------------
describe("GET /api/settings/sync-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getSyncSchedule);
    await expectJson(res, 401);
  });

  it("returns default syncSchedule for new user", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(getSyncSchedule);
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body).toEqual({ settings: { syncSchedule: "DAILY", lastScheduledSync: null } });
    // The settings row is created on first read.
    expect(await storedSyncSchedule(user.id)).toBe("DAILY");
  });

  // The settings row also holds secrets the routes that own them never return.
  it("returns only the schedule, never the secrets stored beside it", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        syncSchedule: "WEEKLY",
        backupEncryptionPassword: "backup-passphrase",
        oidcClientSecret: "oidc-secret",
        aiApiKey: "sk-ai-key",
        discordWebhookUrl: "https://discord.com/api/webhooks/1/secret-token",
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    for (const res of [
      await callRoute(getSyncSchedule),
      await callRoute(putSyncSchedule, { method: "PUT", body: { syncSchedule: "DAILY" } }),
    ]) {
      const body = await expectJson<{ settings: Record<string, unknown> }>(res);
      expect(Object.keys(body.settings).sort()).toEqual(["lastScheduledSync", "syncSchedule"]);
      const text = JSON.stringify(body);
      for (const secret of ["backup-passphrase", "oidc-secret", "sk-ai-key", "secret-token"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("PUT /api/settings/sync-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "WEEKLY" },
    });
    await expectJson(res, 401);
  });

  it("updates syncSchedule with a preset value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "EVERY_6H" },
    });
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("EVERY_6H");
    expect(await storedSyncSchedule(user.id)).toBe("EVERY_6H");
  });

  it("updates syncSchedule with a valid cron expression", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "0 */4 * * *" },
    });
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("0 */4 * * *");
    expect(await storedSyncSchedule(user.id)).toBe("0 */4 * * *");
  });

  it("GET after PUT returns updated value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    await expectJson(await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "WEEKLY" },
    }));

    const res = await callRoute(getSyncSchedule);
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("WEEKLY");
  });

  it("rejects missing syncSchedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^syncSchedule: /);
    expect(await storedSyncSchedule(user.id)).toBeUndefined();
  });

  it("rejects invalid schedule value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "NOT_A_SCHEDULE" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
    expect(await storedSyncSchedule(user.id)).toBeUndefined();
  });

  it("rejects a cron expression the dispatcher cannot evaluate", async () => {
    // node-cron accepts a wrap-around range; cron-parser, which the dispatcher
    // runs, does not — so it used to save and then never run.
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "0 22-2 * * *" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
    expect(await storedSyncSchedule(user.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/settings/schedule-info (GET only)
// ---------------------------------------------------------------------------
describe("GET /api/settings/schedule-info", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getScheduleInfo);
    await expectJson(res, 401);
  });

  it("returns null next-runs when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const res = await callRoute(getScheduleInfo);
    const body = await expectJson(res);
    expect(body).toEqual({
      scheduledJobTime: "00:00",
      timezone: getSystemTimezone(),
      sync: { nextRun: null, lastRun: null },
      detection: { nextRun: null, lastRun: null },
      execution: { nextRun: null, lastRun: null },
    });
  });

  it("returns computed next-run after settings are created", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    const lastSync = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.appSettings.create({
      data: { userId: user.id, syncSchedule: "DAILY", scheduledJobTime: "03:30", lastScheduledSync: lastSync },
    });

    const before = Date.now();
    const res = await callRoute(getScheduleInfo);
    const body = await expectJson<{
      scheduledJobTime: string;
      sync: { nextRun: string; lastRun: string | null };
      detection: { nextRun: string; lastRun: string | null };
    }>(res);
    expect(body.scheduledJobTime).toBe("03:30");
    // A DAILY preset runs at the anchor time on the server's clock: the next
    // 03:30 there, within the coming day (an hour more across a DST change).
    const next = new Date(body.sync.nextRun).getTime();
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(before + 25 * 60 * 60 * 1000);
    expect(serverWallClock(body.sync.nextRun)).toBe("03:30");
    expect(body.sync.lastRun).toBe(lastSync.toISOString());
    // EVERY_6H (the default) from the same anchor: 03:30, 09:30, 15:30, 21:30.
    expect(["03:30", "09:30", "15:30", "21:30"]).toContain(serverWallClock(body.detection.nextRun));
    expect(new Date(body.detection.nextRun).getTime()).toBeLessThanOrEqual(before + 7 * 60 * 60 * 1000);
    expect(body.detection.lastRun).toBeNull();
  });

  it("returns null nextRun for MANUAL schedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
    });

    await prisma.appSettings.create({
      data: {
        userId: user.id,
        syncSchedule: "MANUAL",
        lifecycleDetectionSchedule: "MANUAL",
        lifecycleExecutionSchedule: "MANUAL",
      },
    });

    const res = await callRoute(getScheduleInfo);
    const body = await expectJson<{
      sync: { nextRun: string | null };
      detection: { nextRun: string | null };
      execution: { nextRun: string | null };
    }>(res);
    expect(body.sync.nextRun).toBeNull();
    expect(body.detection.nextRun).toBeNull();
    expect(body.execution.nextRun).toBeNull();
  });
});
