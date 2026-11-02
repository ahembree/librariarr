import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";

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

import { POST } from "@/app/api/settings/schedule-info/run/route";
import {
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  MAIN_QUEUE,
} from "@/lib/jobs/constants";

const prisma = getTestPrisma();

async function setup(overrides?: Record<string, unknown>) {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id, ...overrides } });
  setMockSession({ isLoggedIn: true, userId: user.id});
  return user;
}

describe("POST /api/settings/schedule-info/run", () => {
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

  it("returns 401 without auth", async () => {
    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    await expectJson(res, 401);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown job", async () => {
    await setup();
    const res = await callRoute(POST, { method: "POST", body: { job: "backup" } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^job: /);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("enqueues a sync job for every enabled server (multi-server)", async () => {
    const user = await setup();
    const s1 = await createTestServer(user.id, { name: "Server 1" });
    const s2 = await createTestServer(user.id, { name: "Server 2" });
    const before = Date.now();

    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    expect(await expectJson(res, 200)).toEqual({ queued: true });

    // Both servers enqueued — one is not abandoned because of the other.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    for (const s of [s1, s2]) {
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_SYNC_SERVER,
        { serverId: s.id, trigger: "manual sync from Settings (Run now)" },
        expect.objectContaining({ jobKey: `sync:${s.id}`, queueName: MAIN_QUEUE }),
      );
    }

    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledSync?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("skips disabled servers and servers with an active sync, still updates lastRun", async () => {
    const user = await setup();
    const enabled = await createTestServer(user.id, { name: "Enabled" });
    await createTestServer(user.id, { name: "Disabled", enabled: false });
    const busy = await createTestServer(user.id, { name: "Busy" });
    await prisma.syncJob.create({ data: { mediaServerId: busy.id, status: "RUNNING" } });

    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    await expectJson(res, 200);

    // Only the one enabled, idle server is enqueued.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: enabled.id, trigger: "manual sync from Settings (Run now)" },
      expect.objectContaining({ jobKey: `sync:${enabled.id}` }),
    );

    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledSync).not.toBeNull();
  });

  it("reports a sync that could not be queued instead of answering success", async () => {
    const user = await setup();
    const s1 = await createTestServer(user.id, { name: "Server 1" });
    await createTestServer(user.id, { name: "Server 2" });
    mockEnqueueJob.mockImplementation(async (_task: string, payload: { serverId: string }) => payload.serverId !== s1.id);

    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toBe("Failed to enqueue the sync for 1 of 2 servers");

    // The other server was still queued; the watermark waits for a clean run.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledSync).toBeNull();
  });

  it("enqueues lifecycle detection and stamps lastScheduledLifecycleDetection", async () => {
    const user = await setup();

    const before = Date.now();
    const res = await callRoute(POST, { method: "POST", body: { job: "detection" } });
    expect(await expectJson(res, 200)).toEqual({ queued: true });

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_DETECTION,
      { userId: user.id },
      expect.objectContaining({ jobKey: `detection:${user.id}`, queueName: MAIN_QUEUE }),
    );
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleDetection?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("enqueues lifecycle execution and stamps lastScheduledLifecycleExecution", async () => {
    const user = await setup();

    const before = Date.now();
    const res = await callRoute(POST, { method: "POST", body: { job: "execution" } });
    expect(await expectJson(res, 200)).toEqual({ queued: true });

    // Destructive Arr actions: queued once, never retried as a whole job.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_EXECUTION,
      { userId: user.id },
      expect.objectContaining({ jobKey: `execution:${user.id}`, queueName: MAIN_QUEUE, maxAttempts: 1 }),
    );
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleExecution?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("reports an execution job that could not be queued, leaving the watermark alone", async () => {
    const user = await setup();
    mockEnqueueJob.mockResolvedValueOnce(false);

    const res = await callRoute(POST, { method: "POST", body: { job: "execution" } });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toBe("Failed to enqueue execution job");
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleExecution).toBeNull();
  });

  it("returns 500 when enqueueing a lifecycle job throws", async () => {
    const user = await setup();
    mockEnqueueJob.mockRejectedValueOnce(new Error("boom"));

    const res = await callRoute(POST, { method: "POST", body: { job: "detection" } });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toBe("Job failed: Error: boom");

    // Timestamp not advanced because the enqueue failed.
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleDetection).toBeNull();
  });
});
