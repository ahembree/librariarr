/**
 * The dispatcher advances a schedule's watermark only once its job is durably
 * queued. These cover the failure half of that rule for every schedule: an
 * enqueue that reports failure, and one that throws, both leave the watermark
 * where it was so the next tick retries the window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  isScheduleDue: vi.fn(),
  error: vi.fn(),
  appSettings: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/lib/jobs/schedule", () => ({ isScheduleDue: m.isScheduleDue }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: m.error },
}));
vi.mock("@/lib/db", () => ({ prisma: { appSettings: m.appSettings } }));

import { dispatchScheduledJobs } from "@/lib/jobs/dispatch";
import {
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SCHEDULED_BACKUP,
} from "@/lib/jobs/constants";

const settings = {
  id: "settings-1",
  userId: "user-1",
  syncSchedule: "DAILY",
  lastScheduledSync: null,
  lifecycleDetectionSchedule: "DAILY",
  lastScheduledLifecycleDetection: null,
  lifecycleExecutionSchedule: "DAILY",
  lastScheduledLifecycleExecution: null,
  scheduledJobTime: "03:00",
  user: { mediaServers: [{ id: "s1", enabled: true }, { id: "s2", enabled: true }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.isScheduleDue.mockReturnValue(true);
  m.appSettings.findMany.mockResolvedValue([settings]);
  m.appSettings.findFirst.mockResolvedValue({
    id: "settings-1", backupSchedule: "DAILY", lastBackupAt: null, scheduledJobTime: "03:00",
  });
});

describe("dispatchScheduledJobs enqueue failures", () => {
  it("leaves every watermark unadvanced when every enqueue reports failure", async () => {
    m.enqueueJob.mockResolvedValue(false);

    await dispatchScheduledJobs();

    const tasks = m.enqueueJob.mock.calls.map((c) => c[0]);
    expect(tasks).toEqual([
      TASK_SYNC_SERVER, TASK_SYNC_SERVER, TASK_LIFECYCLE_DETECTION, TASK_LIFECYCLE_EXECUTION, TASK_SCHEDULED_BACKUP,
    ]);
    expect(m.appSettings.update).not.toHaveBeenCalled();
    expect(m.error).toHaveBeenCalledTimes(4);
  });

  it("does not advance the sync watermark when only one server's job could not be queued", async () => {
    m.enqueueJob.mockImplementation(async (task: string, payload: { serverId?: string }) =>
      !(task === TASK_SYNC_SERVER && payload.serverId === "s2"),
    );

    await dispatchScheduledJobs();

    const advanced = m.appSettings.update.mock.calls.map((c) => Object.keys(c[0].data)[0]);
    expect(advanced).toEqual(["lastScheduledLifecycleDetection", "lastScheduledLifecycleExecution", "lastBackupAt"]);
  });

  it("survives an enqueue that throws, for every schedule, without advancing anything", async () => {
    m.enqueueJob.mockRejectedValue(new Error("pool exhausted"));

    await expect(dispatchScheduledJobs()).resolves.toBeUndefined();

    expect(m.appSettings.update).not.toHaveBeenCalled();
    // Sync, detection, execution and backup each report their own failure.
    expect(m.error).toHaveBeenCalledTimes(4);
    for (const call of m.error.mock.calls) {
      expect(call[2]).toEqual({ error: "Error: pool exhausted" });
    }
  });

  it("keeps dispatching the other schedules when a watermark write throws", async () => {
    m.enqueueJob.mockResolvedValue(true);
    m.appSettings.update.mockRejectedValueOnce(new Error("write failed"));

    await dispatchScheduledJobs();

    // The failed sync write is followed by the detection, execution and backup writes.
    expect(m.appSettings.update).toHaveBeenCalledTimes(4);
  });
});
