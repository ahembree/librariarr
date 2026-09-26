import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  syncJobFindFirst: vi.fn(),
  appSettingsUpdate: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique },
    syncJob: { findFirst: m.syncJobFindFirst },
    appSettings: { update: m.appSettingsUpdate },
  },
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runJobNow } from "@/lib/jobs/run-now";
import {
  MAIN_QUEUE,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SYNC_SERVER,
} from "@/lib/jobs/constants";

const SOURCE = 'via API key "Home Assistant"';

describe("runJobNow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.enqueueJob.mockResolvedValue(true);
    m.syncJobFindFirst.mockResolvedValue(null);
  });

  describe("sync", () => {
    it("queues each enabled, idle server with the source in its trigger", async () => {
      m.userFindUnique.mockResolvedValue({
        mediaServers: [
          { id: "s1", name: "One", enabled: true },
          { id: "s2", name: "Two", enabled: false },
          { id: "s3", name: "Three", enabled: true },
        ],
      });
      m.syncJobFindFirst.mockImplementation(async ({ where }: { where: { mediaServerId: string } }) =>
        where.mediaServerId === "s3" ? { id: "busy" } : null,
      );

      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({ ok: true });

      expect(m.enqueueJob).toHaveBeenCalledTimes(1);
      expect(m.enqueueJob).toHaveBeenCalledWith(
        TASK_SYNC_SERVER,
        { serverId: "s1", trigger: `manual sync ${SOURCE}` },
        { jobKey: "sync:s1", queueName: MAIN_QUEUE, maxAttempts: 3 },
      );
      expect(m.appSettingsUpdate).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { lastScheduledSync: expect.any(Date) },
      });
    });

    it("leaves the watermark alone when an enqueue fails", async () => {
      m.userFindUnique.mockResolvedValue({ mediaServers: [{ id: "s1", name: "One", enabled: true }] });
      m.enqueueJob.mockResolvedValue(false);
      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({ ok: true });
      expect(m.appSettingsUpdate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["detection", TASK_LIFECYCLE_DETECTION, "detection:u1", 2, "lastScheduledLifecycleDetection"],
    ["execution", TASK_LIFECYCLE_EXECUTION, "execution:u1", 1, "lastScheduledLifecycleExecution"],
  ] as const)("%s: queues one deduplicated job and stamps the watermark", async (job, task, jobKey, maxAttempts, field) => {
    expect(await runJobNow("u1", job, SOURCE)).toEqual({ ok: true });
    expect(m.enqueueJob).toHaveBeenCalledWith(task, { userId: "u1" }, { jobKey, queueName: MAIN_QUEUE, maxAttempts });
    expect(m.appSettingsUpdate).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { [field]: expect.any(Date) },
    });
  });

  it.each(["detection", "execution"] as const)("%s: reports a failed enqueue without stamping", async (job) => {
    m.enqueueJob.mockResolvedValue(false);
    const result = await runJobNow("u1", job, SOURCE);
    expect(result).toEqual({ ok: false, error: `Failed to enqueue ${job} job` });
    expect(m.appSettingsUpdate).not.toHaveBeenCalled();
  });
});
