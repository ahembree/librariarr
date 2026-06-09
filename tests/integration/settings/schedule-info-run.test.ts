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

const { mockEnqueueJob, mockProcessLifecycleRules, mockExecuteLifecycleActions } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
  mockProcessLifecycleRules: vi.fn().mockResolvedValue(undefined),
  mockExecuteLifecycleActions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));
vi.mock("@/lib/lifecycle/processor", () => ({
  processLifecycleRules: mockProcessLifecycleRules,
  executeLifecycleActions: mockExecuteLifecycleActions,
}));

import { POST } from "@/app/api/settings/schedule-info/run/route";
import { TASK_SYNC_SERVER, MAIN_QUEUE } from "@/lib/jobs/constants";

const prisma = getTestPrisma();

async function setup(overrides?: Record<string, unknown>) {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id, ...overrides } });
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
  return user;
}

describe("POST /api/settings/schedule-info/run", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockEnqueueJob.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    await expectJson(res, 401);
  });

  it("enqueues a sync job for every enabled server (multi-server)", async () => {
    const user = await setup();
    const s1 = await createTestServer(user.id, { name: "Server 1" });
    const s2 = await createTestServer(user.id, { name: "Server 2" });

    const res = await callRoute(POST, { method: "POST", body: { job: "sync" } });
    await expectJson<{ ok: boolean }>(res, 200);

    // Both servers enqueued — one is not abandoned because of the other.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    for (const s of [s1, s2]) {
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_SYNC_SERVER,
        { serverId: s.id },
        expect.objectContaining({ jobKey: `sync:${s.id}`, queueName: MAIN_QUEUE }),
      );
    }

    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledSync).not.toBeNull();
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
      { serverId: enabled.id },
      expect.objectContaining({ jobKey: `sync:${enabled.id}` }),
    );

    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledSync).not.toBeNull();
  });

  it("runs lifecycle detection and stamps lastScheduledLifecycleDetection", async () => {
    const user = await setup();

    const res = await callRoute(POST, { method: "POST", body: { job: "detection" } });
    await expectJson(res, 200);

    expect(mockProcessLifecycleRules).toHaveBeenCalledWith(user.id);
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleDetection).not.toBeNull();
  });

  it("runs lifecycle execution and stamps lastScheduledLifecycleExecution", async () => {
    const user = await setup();

    const res = await callRoute(POST, { method: "POST", body: { job: "execution" } });
    await expectJson(res, 200);

    expect(mockExecuteLifecycleActions).toHaveBeenCalledWith(user.id);
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleExecution).not.toBeNull();
  });

  it("returns 500 when a lifecycle job throws", async () => {
    const user = await setup();
    mockProcessLifecycleRules.mockRejectedValueOnce(new Error("boom"));

    const res = await callRoute(POST, { method: "POST", body: { job: "detection" } });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toContain("Job failed");

    // Timestamp not advanced because the job failed.
    const settings = await prisma.appSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.lastScheduledLifecycleDetection).toBeNull();
  });
});
