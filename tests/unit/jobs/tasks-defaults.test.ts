/**
 * Task-level fallbacks the main task tests do not reach: retention and backup
 * defaults when no settings row exists, the unencrypted-backup warning, and an
 * incremental payload that omits its id lists or a fall-back reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  syncMediaServerItems: vi.fn(),
  enqueueJob: vi.fn().mockResolvedValue(true),
  createBackup: vi.fn().mockResolvedValue("backup.json.gz"),
  getBackupPassphrase: vi.fn(),
  pruneBackups: vi.fn().mockResolvedValue(0),
  warn: vi.fn(),
  appSettings: { findFirst: vi.fn() },
  lifecycleAction: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
}));

vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: vi.fn() }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn() }));
vi.mock("@/lib/sync/sync-incremental", () => ({ syncMediaServerItems: m.syncMediaServerItems }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob, isJobRetrying: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/lifecycle/processor", () => ({
  processLifecycleRules: vi.fn(),
  executeLifecycleActions: vi.fn(),
}));
vi.mock("@/lib/backup/backup-service", () => ({
  createBackup: m.createBackup,
  getBackupPassphrase: m.getBackupPassphrase,
  pruneBackups: m.pruneBackups,
}));
vi.mock("@/lib/logs/archive", () => ({ archiveLogs: vi.fn() }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchScheduledJobs: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  prisma: { appSettings: m.appSettings, lifecycleAction: m.lifecycleAction, syncJob: { findFirst: vi.fn() } },
}));

import { taskList, cleanupOldActions, runScheduledBackup } from "@/lib/jobs/tasks";
import { TASK_SYNC_INCREMENTAL, TASK_SYNC_SERVER, MAIN_QUEUE } from "@/lib/jobs/constants";

beforeEach(() => {
  vi.clearAllMocks();
  m.appSettings.findFirst.mockResolvedValue(null);
});

describe("defaults with no settings row", () => {
  it("prunes action history at the 30-day default", async () => {
    const before = Date.now();
    await cleanupOldActions();
    // The orphan sweep, then the retention pass.
    expect(m.lifecycleAction.deleteMany).toHaveBeenCalledTimes(2);
    const where = JSON.stringify(m.lifecycleAction.deleteMany.mock.calls[1][0].where);
    const cutoffs = [...where.matchAll(/"(\d{4}-\d{2}-\d{2}T[^"]+)"/g)].map((x) => new Date(x[1]).getTime());
    expect(cutoffs.length).toBeGreaterThan(0);
    for (const cutoff of cutoffs) {
      expect(before - cutoff).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
      expect(before - cutoff).toBeLessThan(31 * 86_400_000);
    }
  });

  it("warns that a backup without a passphrase is unencrypted, and keeps 7 backups", async () => {
    m.getBackupPassphrase.mockResolvedValue(null);
    await runScheduledBackup();
    expect(m.warn).toHaveBeenCalledWith("Jobs", expect.stringContaining("UNENCRYPTED"));
    expect(m.createBackup).toHaveBeenCalledWith(null);
    expect(m.pruneBackups).toHaveBeenCalledWith(7);
  });

  it("does not warn when the backup is encrypted", async () => {
    m.getBackupPassphrase.mockResolvedValue("secret");
    m.appSettings.findFirst.mockResolvedValue({ backupRetentionCount: 3 });
    await runScheduledBackup();
    expect(m.warn).not.toHaveBeenCalled();
    expect(m.pruneBackups).toHaveBeenCalledWith(3);
  });
});

describe("incremental task payload fallbacks", () => {
  const run = (payload: unknown) =>
    (taskList[TASK_SYNC_INCREMENTAL] as (p: unknown, h: unknown) => Promise<void>)(payload, {} as never);

  it("treats missing id lists as empty", async () => {
    m.syncMediaServerItems.mockResolvedValue({ status: "done", upserted: 0, deleted: 0 });
    await run({ serverId: "s1" });
    expect(m.syncMediaServerItems).toHaveBeenCalledWith("s1", [], []);
    expect(m.enqueueJob).not.toHaveBeenCalled();
  });

  it("states that no reason was given when a fall-back carries none", async () => {
    m.syncMediaServerItems.mockResolvedValue({ status: "fell-back", upserted: 0, deleted: 0 });
    await run({ serverId: "s1", changedIds: ["a"] });
    expect(m.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: "s1", trigger: "incremental sync fell back to a full sync: no reason given" },
      { jobKey: "sync:s1", queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
  });
});
