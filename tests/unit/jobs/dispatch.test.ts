import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  enqueueJob: vi.fn().mockResolvedValue(true),
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

  it("evaluates each schedule against its own watermark and the configured time", async () => {
    const lastSync = new Date("2026-03-01T03:00:00Z");
    const lastDetection = new Date("2026-03-02T04:00:00Z");
    const lastExecution = new Date("2026-03-03T05:00:00Z");
    const lastBackup = new Date("2026-03-04T06:00:00Z");
    isScheduleDue.mockReturnValue(false);
    appSettings.findMany.mockResolvedValue([
      settingsRow({
        syncSchedule: "EVERY_6H",
        lastScheduledSync: lastSync,
        lifecycleDetectionSchedule: "DAILY",
        lastScheduledLifecycleDetection: lastDetection,
        lifecycleExecutionSchedule: "WEEKLY",
        lastScheduledLifecycleExecution: lastExecution,
        scheduledJobTime: "02:30",
      }),
    ]);
    appSettings.findFirst.mockResolvedValue({
      id: "settings-1",
      backupSchedule: "EVERY_12H",
      lastBackupAt: lastBackup,
      scheduledJobTime: "02:30",
    });

    await dispatchScheduledJobs();

    // One instant for the whole tick, so every schedule is judged at the same moment.
    const now = isScheduleDue.mock.calls[0][2];
    expect(now).toBeInstanceOf(Date);
    expect(isScheduleDue.mock.calls).toEqual([
      ["EVERY_6H", lastSync, now, "02:30"],
      ["DAILY", lastDetection, now, "02:30"],
      ["WEEKLY", lastExecution, now, "02:30"],
      ["EVERY_12H", lastBackup, now, "02:30"],
    ]);
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
      { serverId: "server-1", trigger: "scheduled sync" },
      { jobKey: "sync:server-1", queueName: MAIN_QUEUE, maxAttempts: 3 },
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
      { jobKey: "detection:user-1", queueName: MAIN_QUEUE, maxAttempts: 2 },
    );
    // Execution must not auto-retry destructive Arr actions.
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_LIFECYCLE_EXECUTION,
      { userId: "user-1" },
      { jobKey: "execution:user-1", queueName: MAIN_QUEUE, maxAttempts: 1 },
    );
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    // Each watermark advances on its own, and the sync's (not due) does not.
    expect(appSettings.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "settings-1" }, data: { lastScheduledLifecycleDetection: expect.any(Date) } },
      { where: { id: "settings-1" }, data: { lastScheduledLifecycleExecution: expect.any(Date) } },
    ]);
  });

  it("enqueues a backup when the backup schedule is due", async () => {
    appSettings.findMany.mockResolvedValue([settingsRow()]);
    appSettings.findFirst.mockResolvedValue({
      id: "settings-1",
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

    // Watermark advanced via a row-scoped update (not an unscoped updateMany).
    expect(appSettings.update).toHaveBeenCalledWith({
      where: { id: "settings-1" },
      data: { lastBackupAt: expect.any(Date) },
    });
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_SCHEDULED_BACKUP,
      {},
      { jobKey: "scheduled-backup", queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
  });

  it("does not enqueue a backup when the schedule is MANUAL", async () => {
    // Every other schedule is due, so only the MANUAL check can keep the
    // backup out — a not-due answer would hide its absence.
    isScheduleDue.mockReturnValue(true);
    appSettings.findMany.mockResolvedValue([settingsRow()]);
    appSettings.findFirst.mockResolvedValue({
      backupSchedule: "MANUAL",
      lastBackupAt: null,
      scheduledJobTime: "03:00",
    });

    await dispatchScheduledJobs();

    expect(enqueueJob).toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalledWith(TASK_SCHEDULED_BACKUP, expect.anything(), expect.anything());
    expect(appSettings.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastBackupAt: expect.any(Date) } }),
    );
  });
});
