import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer } from "../../setup/test-helpers";

/**
 * `pruneSyncJobs` against the real database: a finished job goes only when it
 * is both older than the retention and past its server's newest
 * `SYNC_JOB_KEEP_PER_SERVER`; an active job never goes.
 */
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pruneSyncJobs, SYNC_JOB_KEEP_PER_SERVER, SYNC_JOB_RETENTION_DAYS } from "@/lib/jobs/tasks";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-26T12:00:00Z");
const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

/** `count` finished jobs for a server, one a day going back from `newestDaysAgo`. */
async function jobs(serverId: string, count: number, newestDaysAgo: number, status: "COMPLETED" | "FAILED" = "COMPLETED") {
  await prisma.syncJob.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      mediaServerId: serverId,
      status,
      startedAt: new Date(NOW.getTime() - (newestDaysAgo + i) * DAY),
      completedAt: new Date(NOW.getTime() - (newestDaysAgo + i) * DAY + 60_000),
    })),
  });
}

describe("pruneSyncJobs", () => {
  it("removes only old finished jobs past each server's newest few, and never an active one", async () => {
    const user = await createTestUser();
    const busy = await createTestServer(user.id, { name: "Busy" });
    const quiet = await createTestServer(user.id, { name: "Quiet" });

    // Busy: 80 jobs, one a day from today back — so the newest 50 cover 0..49
    // days, of which 0..29 are inside the retention anyway.
    await jobs(busy.id, 80, 0);
    // A sync that has been "running" for 90 days (an orphan) and a queued one.
    await prisma.syncJob.create({ data: { mediaServerId: busy.id, status: "RUNNING", startedAt: new Date(NOW.getTime() - 90 * DAY) } });
    await prisma.syncJob.create({ data: { mediaServerId: busy.id, status: "PENDING", startedAt: new Date(NOW.getTime() - 95 * DAY) } });
    // Quiet: ten old jobs — under the per-server floor, so all are kept.
    await jobs(quiet.id, 10, 200, "FAILED");

    const removed = await pruneSyncJobs(NOW);

    // Busy jobs ranked past 50 are 50..79 days old (plus the two active rows
    // ranked last), all older than the retention: 30 go.
    expect(removed).toBe(80 - SYNC_JOB_KEEP_PER_SERVER);
    const left = await prisma.syncJob.findMany({ where: { mediaServerId: busy.id }, orderBy: { startedAt: "desc" } });
    expect(left.filter((j) => j.status === "COMPLETED")).toHaveLength(SYNC_JOB_KEEP_PER_SERVER);
    expect(left.map((j) => j.status)).toEqual(expect.arrayContaining(["RUNNING", "PENDING"]));
    expect(await prisma.syncJob.count({ where: { mediaServerId: quiet.id } })).toBe(10);

    // Idempotent.
    expect(await pruneSyncJobs(NOW)).toBe(0);
  });

  it("keeps every job inside the retention, however many there are", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    // 120 jobs, all within the last few days.
    await prisma.syncJob.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        mediaServerId: server.id,
        status: "COMPLETED" as const,
        startedAt: new Date(NOW.getTime() - i * 60 * 60 * 1000),
      })),
    });

    expect(await pruneSyncJobs(NOW)).toBe(0);
    expect(await prisma.syncJob.count()).toBe(120);
    expect(SYNC_JOB_RETENTION_DAYS * DAY).toBeGreaterThan(120 * 60 * 60 * 1000);
  });
});
