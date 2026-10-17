/**
 * Task-level fallbacks the main task tests do not reach: retention and backup
 * defaults when no settings row exists, the unencrypted-backup warning, and an
 * incremental payload that omits its id lists or a fall-back reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes action history at the 30-day default", async () => {
    // A fixed clock in a stretch with no daylight-saving change anywhere: the
    // cutoff is computed in local calendar days, so across a change it would
    // be 30 days ± 1 hour and an exact assertion would depend on the TZ.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    await cleanupOldActions();
    // The orphan sweep, then the retention pass.
    expect(m.lifecycleAction.deleteMany).toHaveBeenCalledTimes(2);
    const cutoff = new Date("2026-06-15T12:00:00.000Z");
    expect(m.lifecycleAction.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: { not: "PENDING" },
        OR: [
          { executedAt: { lt: cutoff } },
          { executedAt: null, createdAt: { lt: cutoff } },
        ],
      },
    });
  });

  it("warns that a backup without a passphrase is unencrypted, and keeps 7 backups", async () => {
    m.getBackupPassphrase.mockResolvedValue(null);
    await runScheduledBackup();
    expect(m.warn).toHaveBeenCalledWith(
      "Jobs",
      "Scheduled backup is UNENCRYPTED — it contains plaintext secrets. Set a backup encryption password under Settings → General.",
    );
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
