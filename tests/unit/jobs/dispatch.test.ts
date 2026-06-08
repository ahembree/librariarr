import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  isScheduleDue: vi.fn(),
  appSettings: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({}),
  },
}));
const { enqueueJob, isScheduleDue, appSettings } = m;

vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/lib/jobs/schedule", () => ({ isScheduleDue: m.isScheduleDue }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { appSettings: m.appSettings } }));

import { dispatchScheduledJobs } from "@/lib/jobs/dispatch";
import {
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SCHEDULED_BACKUP,
  MAIN_QUEUE,
} from "@/lib/jobs/constants";

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "settings-1",
    userId: "user-1",
    syncSchedule: "DAILY",
    lastScheduledSync: null,
    lifecycleDetectionSchedule: "DAILY",
    lastScheduledLifecycleDetection: null,
    lifecycleExecutionSchedule: "DAILY",
    lastScheduledLifecycleExecution: null,
    scheduledJobTime: "03:00",
    user: {
      mediaServers: [
        { id: "server-1", enabled: true },
        { id: "server-2", enabled: false },
      ],
    },
    ...overrides,
  };
}

describe("dispatchScheduledJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appSettings.findFirst.mockResolvedValue({
      backupSchedule: "MANUAL",
      lastBackupAt: null,
      scheduledJobTime: "03:00",
    });
  });

  it("enqueues nothing when no schedules are due", async () => {
    isScheduleDue.mockReturnValue(false);
    appSettings.findMany.mockResolvedValue([settingsRow()]);

    await dispatchScheduledJobs();

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(appSettings.update).not.toHaveBeenCalled();
  });

  it("enqueues sync only for enabled servers and advances the timestamp", async () => {
    // First call (sync) true, the rest false.
    isScheduleDue
      .mockReturnValueOnce(true) // sync
      .mockReturnValue(false); // detection, execution, backup
    appSettings.findMany.mockResolvedValue([settingsRow()]);

    await dispatchScheduledJobs();

    expect(appSettings.update).toHaveBeenCalledWith({
      where: { id: "settings-1" },
      data: { lastScheduledSync: expect.any(Date) },
    });
    // Only the enabled server is enqueued
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: "server-1" },
      expect.objectContaining({ jobKey: "sync:server-1", queueName: MAIN_QUEUE }),
    );
  });

  it("enqueues lifecycle detection and execution when due", async () => {
    isScheduleDue
      .mockReturnValueOnce(false) // sync
      .mockReturnValueOnce(true) // detection
      .mockReturnValueOnce(true) // execution
      .mockReturnValue(false); // backup
    appSettings.findMany.mockResolvedValue([settingsRow()]);

    await dispatchScheduledJobs();

    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_DETECTION,
      { userId: "user-1" },
      expect.objectContaining({ jobKey: "detection:user-1", queueName: MAIN_QUEUE }),
    );
    // Execution must not auto-retry destructive Arr actions.
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_EXECUTION,
      { userId: "user-1" },
      expect.objectContaining({ jobKey: "execution:user-1", queueName: MAIN_QUEUE, maxAttempts: 1 }),
    );
  });

  it("enqueues a backup when the backup schedule is due", async () => {
    appSettings.findMany.mockResolvedValue([settingsRow()]);
    appSettings.findFirst.mockResolvedValue({
      backupSchedule: "DAILY",
      lastBackupAt: null,
      scheduledJobTime: "03:00",
    });
    // Per-row schedules (sync, detection, execution) not due; backup due.
    isScheduleDue
      .mockReturnValueOnce(false) // sync
      .mockReturnValueOnce(false) // detection
      .mockReturnValueOnce(false) // execution
      .mockReturnValueOnce(true); // backup

    await dispatchScheduledJobs();

    expect(appSettings.updateMany).toHaveBeenCalledWith({ data: { lastBackupAt: expect.any(Date) } });
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_SCHEDULED_BACKUP,
      {},
      expect.objectContaining({ jobKey: "scheduled-backup", queueName: MAIN_QUEUE }),
    );
  });

  it("does not enqueue a backup when the schedule is MANUAL", async () => {
    isScheduleDue.mockReturnValue(false);
    appSettings.findMany.mockResolvedValue([settingsRow()]);
    appSettings.findFirst.mockResolvedValue({
      backupSchedule: "MANUAL",
      lastBackupAt: null,
      scheduledJobTime: "03:00",
    });

    await dispatchScheduledJobs();

    expect(enqueueJob).not.toHaveBeenCalledWith(TASK_SCHEDULED_BACKUP, expect.anything(), expect.anything());
  });
});
