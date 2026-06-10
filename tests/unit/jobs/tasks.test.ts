import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  syncMediaServer: vi.fn().mockResolvedValue(undefined),
  processLifecycleRules: vi.fn().mockResolvedValue(undefined),
  executeLifecycleActions: vi.fn().mockResolvedValue(undefined),
  createBackup: vi.fn().mockResolvedValue("backup.json.gz"),
  getBackupPassphrase: vi.fn().mockResolvedValue("pw"),
  pruneBackups: vi.fn().mockResolvedValue(0),
  archiveLogs: vi.fn().mockResolvedValue(undefined),
  dispatchScheduledJobs: vi.fn().mockResolvedValue(undefined),
  syncJob: { findFirst: vi.fn() },
  appSettings: { findFirst: vi.fn() },
  lifecycleAction: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
}));
const {
  syncMediaServer, processLifecycleRules, executeLifecycleActions, createBackup,
  getBackupPassphrase, pruneBackups, archiveLogs, dispatchScheduledJobs,
  syncJob, appSettings, lifecycleAction,
} = m;

vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: m.syncMediaServer }));
vi.mock("@/lib/lifecycle/processor", () => ({
  processLifecycleRules: m.processLifecycleRules,
  executeLifecycleActions: m.executeLifecycleActions,
}));
vi.mock("@/lib/backup/backup-service", () => ({
  createBackup: m.createBackup,
  getBackupPassphrase: m.getBackupPassphrase,
  pruneBackups: m.pruneBackups,
}));
vi.mock("@/lib/logs/archive", () => ({ archiveLogs: m.archiveLogs }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchScheduledJobs: m.dispatchScheduledJobs }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  prisma: { syncJob: m.syncJob, appSettings: m.appSettings, lifecycleAction: m.lifecycleAction },
}));

import { taskList, cleanupOldActions, runScheduledBackup } from "@/lib/jobs/tasks";
import {
  TASK_DISPATCH,
  TASK_SYNC_SERVER,
  TASK_LIFECYCLE_DETECTION,
  TASK_LIFECYCLE_EXECUTION,
  TASK_SCHEDULED_BACKUP,
  TASK_ARCHIVE_LOGS,
  TASK_CLEANUP_ACTIONS,
} from "@/lib/jobs/constants";

// Minimal helpers object — tasks here don't use the helpers argument.
const helpers = {} as never;

describe("taskList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncJob.findFirst.mockResolvedValue(null);
    appSettings.findFirst.mockResolvedValue({ actionHistoryRetentionDays: 30, backupRetentionCount: 7 });
  });

  it("registers every task identifier", () => {
    expect(Object.keys(taskList).sort()).toEqual(
      [
        TASK_DISPATCH,
        TASK_SYNC_SERVER,
        TASK_LIFECYCLE_DETECTION,
        TASK_LIFECYCLE_EXECUTION,
        TASK_SCHEDULED_BACKUP,
        TASK_ARCHIVE_LOGS,
        TASK_CLEANUP_ACTIONS,
      ].sort(),
    );
  });

  it("dispatch task runs the dispatcher", async () => {
    await (taskList[TASK_DISPATCH] as (p: unknown, h: unknown) => Promise<void>)({}, helpers);
    expect(dispatchScheduledJobs).toHaveBeenCalledOnce();
  });

  it("sync task syncs the server when none is running", async () => {
    await (taskList[TASK_SYNC_SERVER] as (p: unknown, h: unknown) => Promise<void>)(
      { serverId: "server-1", libraryKey: "lib-1", skipWatchHistory: true },
      helpers,
    );
    expect(syncMediaServer).toHaveBeenCalledWith("server-1", "lib-1", { skipWatchHistory: true });
  });

  it("sync task skips when a sync is already running", async () => {
    syncJob.findFirst.mockResolvedValue({ id: "running" });
    await (taskList[TASK_SYNC_SERVER] as (p: unknown, h: unknown) => Promise<void>)(
      { serverId: "server-1" },
      helpers,
    );
    expect(syncMediaServer).not.toHaveBeenCalled();
  });

  it("lifecycle tasks delegate to the processor with the userId", async () => {
    await (taskList[TASK_LIFECYCLE_DETECTION] as (p: unknown, h: unknown) => Promise<void>)({ userId: "u1" }, helpers);
    await (taskList[TASK_LIFECYCLE_EXECUTION] as (p: unknown, h: unknown) => Promise<void>)({ userId: "u1" }, helpers);
    expect(processLifecycleRules).toHaveBeenCalledWith("u1");
    expect(executeLifecycleActions).toHaveBeenCalledWith("u1");
  });

  it("archive and cleanup tasks delegate to their helpers", async () => {
    await (taskList[TASK_ARCHIVE_LOGS] as (p: unknown, h: unknown) => Promise<void>)({}, helpers);
    await (taskList[TASK_CLEANUP_ACTIONS] as (p: unknown, h: unknown) => Promise<void>)({}, helpers);
    expect(archiveLogs).toHaveBeenCalledOnce();
    expect(lifecycleAction.deleteMany).toHaveBeenCalledOnce();
  });
});

describe("cleanupOldActions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips deletion when retention is 0 (keep forever)", async () => {
    appSettings.findFirst.mockResolvedValue({ actionHistoryRetentionDays: 0 });
    await cleanupOldActions();
    expect(lifecycleAction.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes non-pending actions older than the cutoff", async () => {
    appSettings.findFirst.mockResolvedValue({ actionHistoryRetentionDays: 30 });
    lifecycleAction.deleteMany.mockResolvedValue({ count: 4 });
    await cleanupOldActions();
    expect(lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { status: { not: "PENDING" }, createdAt: { lt: expect.any(Date) } },
    });
  });
});

describe("runScheduledBackup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a backup and prunes to the configured retention count", async () => {
    appSettings.findFirst.mockResolvedValue({ backupRetentionCount: 5 });
    await runScheduledBackup();
    expect(getBackupPassphrase).toHaveBeenCalledOnce();
    expect(createBackup).toHaveBeenCalledWith("pw");
    expect(pruneBackups).toHaveBeenCalledWith(5);
  });

  it("defaults retention to 7 when settings are missing", async () => {
    appSettings.findFirst.mockResolvedValue(null);
    await runScheduledBackup();
    expect(pruneBackups).toHaveBeenCalledWith(7);
  });
});
