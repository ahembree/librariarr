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

      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({ ok: true, jobs: 1 });

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

    it("reports a failed enqueue, and leaves the watermark alone", async () => {
      m.userFindUnique.mockResolvedValue({ mediaServers: [{ id: "s1", name: "One", enabled: true }] });
      m.enqueueJob.mockResolvedValue(false);
      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({
        ok: false,
        error: "Failed to enqueue the sync for 1 of 1 server",
      });
      expect(m.appSettingsUpdate).not.toHaveBeenCalled();
    });

    it("still queues the other servers when one enqueue fails, and says how many failed", async () => {
      m.userFindUnique.mockResolvedValue({
        mediaServers: [
          { id: "s1", name: "One", enabled: true },
          { id: "s2", name: "Two", enabled: true },
          { id: "s3", name: "Three", enabled: true },
        ],
      });
      m.enqueueJob.mockImplementation(async (_task: string, payload: { serverId: string }) => payload.serverId !== "s2");
      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({
        ok: false,
        error: "Failed to enqueue the sync for 1 of 3 servers",
      });
      expect(m.enqueueJob).toHaveBeenCalledTimes(3);
      expect(m.appSettingsUpdate).not.toHaveBeenCalled();
    });

    it("queues nothing, successfully, when every server is already syncing or none is enabled", async () => {
      m.userFindUnique.mockResolvedValue({
        mediaServers: [
          { id: "s1", name: "One", enabled: true },
          { id: "s2", name: "Two", enabled: false },
        ],
      });
      m.syncJobFindFirst.mockResolvedValue({ id: "busy" });
      expect(await runJobNow("u1", "sync", SOURCE)).toEqual({ ok: true, jobs: 0 });
      expect(m.enqueueJob).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["detection", TASK_LIFECYCLE_DETECTION, "detection:u1", 2, "lastScheduledLifecycleDetection"],
    ["execution", TASK_LIFECYCLE_EXECUTION, "execution:u1", 1, "lastScheduledLifecycleExecution"],
  ] as const)("%s: queues one deduplicated job and stamps the watermark", async (job, task, jobKey, maxAttempts, field) => {
    expect(await runJobNow("u1", job, SOURCE)).toEqual({ ok: true, jobs: 1 });
    expect(m.enqueueJob).toHaveBeenCalledWith(task, { userId: "u1" }, { jobKey, queueName: MAIN_QUEUE, maxAttempts });
    expect(m.appSettingsUpdate).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { [field]: expect.any(Date) },
    });
  });

  it("execution through an API key: its own job key, the key in the payload, no watermark", async () => {
    // The payload flag is what holds the run to the API's destructive limits;
    // a separate key keeps the dispatcher from replacing it (or it replacing a
    // scheduled run), and skipping the watermark keeps a held run from
    // postponing the scheduled one.
    expect(await runJobNow("u1", "execution", SOURCE, { viaApiKey: "n8n" })).toEqual({ ok: true, jobs: 1 });
    expect(m.enqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_EXECUTION,
      { userId: "u1", viaApiKey: "n8n" },
      { jobKey: "execution-api:u1", queueName: MAIN_QUEUE, maxAttempts: 1 },
    );
    expect(m.appSettingsUpdate).not.toHaveBeenCalled();
  });

  it("detection through an API key queues exactly what Settings does", async () => {
    expect(await runJobNow("u1", "detection", SOURCE, { viaApiKey: "n8n" })).toEqual({ ok: true, jobs: 1 });
    expect(m.enqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_DETECTION,
      { userId: "u1" },
      { jobKey: "detection:u1", queueName: MAIN_QUEUE, maxAttempts: 2 },
    );
  });

  it.each(["detection", "execution"] as const)("%s: reports a failed enqueue without stamping", async (job) => {
    m.enqueueJob.mockResolvedValue(false);
    const result = await runJobNow("u1", job, SOURCE);
    expect(result).toEqual({ ok: false, error: `Failed to enqueue ${job} job` });
    expect(m.appSettingsUpdate).not.toHaveBeenCalled();
  });
});
