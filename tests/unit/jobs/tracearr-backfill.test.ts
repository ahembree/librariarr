import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The self-re-enqueueing Tracearr backfill job.
 *
 * Tracearr serves history newest-first, so importing an archive means walking
 * backwards — ~1,600 sequential pages for a 160k-play library. `MAIN_QUEUE` is
 * serial, so that walk cannot be one long job (it would block every sync and
 * lifecycle run behind it) and it cannot live in a request either. Instead each
 * run takes a bounded 5-minute slice and re-enqueues itself while there is more
 * history below.
 *
 * The invariants worth locking down are all failure modes that are invisible in
 * a passing app: a task that exists but is never wired into `taskList` silently
 * never runs; a re-enqueue under the wrong jobKey stacks a second concurrent
 * walk over the same pages; a missing `invalidateMediaCaches()` hides the newly
 * imported plays behind a cache TTL; and a re-enqueue on the error path would
 * duplicate the job that graphile-worker is already retrying.
 */

const m = vi.hoisted(() => ({
  syncTracearrHistory: vi.fn(),
  syncMediaServer: vi.fn().mockResolvedValue(undefined),
  syncWatchHistory: vi.fn().mockResolvedValue({ count: 0 }),
  syncMediaServerItems: vi.fn().mockResolvedValue({ status: "done", upserted: 0, deleted: 0 }),
  enqueueJob: vi.fn().mockResolvedValue(true),
  invalidateMediaCaches: vi.fn(),
  processLifecycleRules: vi.fn().mockResolvedValue(undefined),
  executeLifecycleActions: vi.fn().mockResolvedValue(undefined),
  createBackup: vi.fn().mockResolvedValue("backup.json.gz"),
  getBackupPassphrase: vi.fn().mockResolvedValue("pw"),
  pruneBackups: vi.fn().mockResolvedValue(0),
  archiveLogs: vi.fn().mockResolvedValue(undefined),
  pruneImageCache: vi.fn().mockResolvedValue(0),
  dispatchScheduledJobs: vi.fn().mockResolvedValue(undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  syncJob: { findFirst: vi.fn().mockResolvedValue(null) },
  appSettings: { findFirst: vi.fn().mockResolvedValue(null) },
  lifecycleAction: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
}));
const { syncTracearrHistory, enqueueJob, invalidateMediaCaches, logger } = m;

vi.mock("@/lib/sync/sync-tracearr-history", () => ({ syncTracearrHistory: m.syncTracearrHistory }));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: m.syncMediaServer }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: m.syncWatchHistory }));
vi.mock("@/lib/sync/sync-incremental", () => ({ syncMediaServerItems: m.syncMediaServerItems }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: m.invalidateMediaCaches }));
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
vi.mock("@/lib/image-cache/image-cache", () => ({ pruneImageCache: m.pruneImageCache }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchScheduledJobs: m.dispatchScheduledJobs }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/db", () => ({
  prisma: { syncJob: m.syncJob, appSettings: m.appSettings, lifecycleAction: m.lifecycleAction },
}));

import { taskList } from "@/lib/jobs/tasks";
import { TASK_TRACEARR_BACKFILL, MAIN_QUEUE } from "@/lib/jobs/constants";

/** Mirrors `TRACEARR_BACKFILL_SLICE_MS` in tasks.ts (module-private there). */
const SLICE_MS = 5 * 60_000;

const SERVER_ID = "server-1";

/** Tasks here don't touch the graphile-worker helpers argument. */
const helpers = {} as never;

/**
 * Invoke the task the way graphile-worker does — through `taskList`, not via a
 * direct import of the handler. A handler that is never registered would still
 * pass every behavioural assertion below while never running in production.
 */
function runBackfill(payload: unknown = { serverId: SERVER_ID }): Promise<void> {
  const task = taskList[TASK_TRACEARR_BACKFILL] as (p: unknown, h: unknown) => Promise<void>;
  return task(payload, helpers);
}

describe("tracearr-backfill task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueJob.mockResolvedValue(true);
    syncTracearrHistory.mockResolvedValue({ count: 0, backfillPending: false });
  });

  it("is registered in taskList under TASK_TRACEARR_BACKFILL", () => {
    expect(taskList[TASK_TRACEARR_BACKFILL]).toBeTypeOf("function");
  });

  it("runs the backfill pass only, with a deadline one slice ahead", async () => {
    syncTracearrHistory.mockResolvedValue({ count: 500, backfillPending: true });

    const before = Date.now();
    await runBackfill();
    const after = Date.now();

    expect(syncTracearrHistory).toHaveBeenCalledOnce();
    const [serverId, options] = syncTracearrHistory.mock.calls[0] as [
      string,
      { passes: string; deadlineMs: number },
    ];
    expect(serverId).toBe(SERVER_ID);
    // Forward catch-up belongs to the watch-history sync; this job only walks
    // backwards, or every slice would redo the same bounded forward pass.
    expect(options.passes).toBe("backfill");
    // The deadline must be in the future (a past/absent one makes the slice a
    // no-op and the job re-enqueues forever) and no further out than the slice
    // (a longer one monopolises the serial MAIN_QUEUE).
    expect(options.deadlineMs).toBeGreaterThan(before);
    expect(options.deadlineMs).toBeGreaterThanOrEqual(before + SLICE_MS);
    expect(options.deadlineMs).toBeLessThanOrEqual(after + SLICE_MS);
  });

  it("re-enqueues itself under the foreground jobKey while history remains", async () => {
    syncTracearrHistory.mockResolvedValue({ count: 1_000, backfillPending: true });

    await runBackfill();

    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(enqueueJob).toHaveBeenCalledWith(
      TASK_TRACEARR_BACKFILL,
      { serverId: SERVER_ID },
      {
        // Asserted as an exact string on purpose: the foreground watch-history
        // sync enqueues the backfill under this same key, so a mismatch here
        // would let a user pressing Refresh mid-backfill stack a second walk
        // over the same pages instead of collapsing onto this run.
        jobKey: `tracearr-backfill:${SERVER_ID}`,
        queueName: MAIN_QUEUE,
        maxAttempts: 3,
      },
    );
  });

  it("stops re-enqueueing and logs completion once the walk reaches the oldest play", async () => {
    syncTracearrHistory.mockResolvedValue({ count: 37, backfillPending: false });

    await runBackfill();

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Jobs",
      expect.stringContaining("complete"),
    );
    expect(logger.info).toHaveBeenCalledWith("Jobs", expect.stringContaining(SERVER_ID));
  });

  it("invalidates media caches whether or not more history remains", async () => {
    syncTracearrHistory.mockResolvedValue({ count: 500, backfillPending: true });
    await runBackfill();
    // Newly imported plays must be visible immediately rather than waiting out
    // the watch-history-derived cache TTLs.
    expect(invalidateMediaCaches).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    syncTracearrHistory.mockResolvedValue({ count: 12, backfillPending: false });
    await runBackfill();
    expect(invalidateMediaCaches).toHaveBeenCalledOnce();
  });

  it("propagates a failure so graphile-worker retries, without stacking a duplicate job", async () => {
    syncTracearrHistory.mockRejectedValue(new Error("tracearr 502"));

    await expect(runBackfill()).rejects.toThrow("tracearr 502");

    // The job's own maxAttempts drives the retry. Enqueueing here too would put
    // a second walk beside the one graphile-worker is already going to re-run.
    expect(enqueueJob).not.toHaveBeenCalled();
    // Nothing was imported, so there is nothing to invalidate either.
    expect(invalidateMediaCaches).not.toHaveBeenCalled();
  });

  describe("failure handling", () => {
    it("does not re-enqueue when the slice could not reach Tracearr", async () => {
      // Nothing about the next run would differ, so re-queueing immediately
      // spins as fast as the queue turns over — hammering an instance that is
      // already down and burning the rate limit its recovery needs. Throwing
      // hands it to graphile-worker's own backoff instead.
      syncTracearrHistory.mockResolvedValue({
        count: 0,
        backfillPending: true,
        backfillOutcome: "errored",
      });

      await expect(runBackfill()).rejects.toThrow(/could not reach Tracearr/);
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("re-enqueues immediately when the slice merely ran out of time", async () => {
      // The opposite case: a time-sliced stop made real progress, so the next
      // slice should start as soon as the queue frees up.
      syncTracearrHistory.mockResolvedValue({
        count: 120,
        backfillPending: true,
        backfillOutcome: "stopped",
      });

      await runBackfill();

      expect(enqueueJob).toHaveBeenCalledTimes(1);
    });
  });

});
