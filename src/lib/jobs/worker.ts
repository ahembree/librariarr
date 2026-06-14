import { run, runMigrations, parseCrontab, type Runner } from "graphile-worker";
import type { Pool } from "pg";
import { logger } from "@/lib/logger";
import { getJobsPool } from "@/lib/jobs/client";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_DISPATCH, TASK_ARCHIVE_LOGS, TASK_CLEANUP_ACTIONS, TASK_PRUNE_IMAGE_CACHE } from "@/lib/jobs/constants";

/**
 * Static crontab driving the recurring tasks.
 *
 * - The dispatcher runs every minute and fans out user-configured (DB-stored)
 *   schedules into durable jobs.
 * - Housekeeping tasks run on a coarser cadence; both are idempotent and decide
 *   internally whether there is anything to do.
 */
const CRONTAB = `
* * * * * ${TASK_DISPATCH}
*/15 * * * * ${TASK_CLEANUP_ACTIONS}
0 * * * * ${TASK_ARCHIVE_LOGS}
30 3 * * * ${TASK_PRUNE_IMAGE_CACHE}
`.trim();

let runner: Runner | undefined;
let startPromise: Promise<void> | undefined;

/**
 * Release graphile_worker locks left behind by a previous process that exited
 * mid-job (container restart, crash, OOM kill).
 *
 * Graphile Worker serializes heavy domain jobs (sync, lifecycle, backup) on the
 * named `MAIN_QUEUE`. While a queued job runs, its worker holds a lock on
 * the queue row (`locked_at`/`locked_by`). A clean shutdown releases that lock,
 * but a hard kill leaves it set forever — and `getJob` will not pick up *any*
 * job whose queue is locked, so every MAIN_QUEUE job (every sync, every
 * lifecycle run, every backup) stalls until graphile-worker's stale-lock sweep
 * clears it — which only happens after **4 hours**. That is the
 * "restart mid-sync ⇒ syncs stop working" failure.
 *
 * Librariarr runs exactly one in-process worker, so any lock present at boot is
 * necessarily orphaned — there is no other live worker it could belong to.
 * Clearing them unconditionally (rather than waiting out the 4-hour interval)
 * lets the new worker resume MAIN_QUEUE work immediately. Runs before the runner
 * starts so it can never race a freshly-acquired lock from the new worker.
 */
export async function recoverOrphanedWorkerLocks(pgPool: Pool): Promise<void> {
  // Ensure the graphile_worker schema exists before touching its tables; on a
  // first-ever boot the worker migrations have not run yet. Idempotent — `run()`
  // applies the same migrations again when it starts.
  await runMigrations({ pgPool });

  // Free the queues first so the new worker can immediately dequeue, then the
  // jobs themselves so the interrupted job becomes runnable again (it retries
  // under its own maxAttempts). Internal `_private_*` tables are the only place
  // these locks live; the public `jobs`/`job_queues` views are not updatable.
  await pgPool.query(
    `update graphile_worker._private_job_queues
        set locked_at = null, locked_by = null
      where locked_at is not null`,
  );
  await pgPool.query(
    `update graphile_worker._private_jobs
        set locked_at = null, locked_by = null
      where locked_at is not null`,
  );
}

/**
 * Start the in-process Graphile Worker runner. Idempotent — repeated calls
 * return the same in-flight/completed start. `run()` applies the worker's own
 * migrations (creating the `graphile_worker` schema) before resolving, so by
 * the time this returns the queue is ready to accept jobs.
 */
export async function startWorker(): Promise<void> {
  if (runner) return;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const pgPool = getJobsPool();

    // Recover from an unclean previous shutdown before the runner starts:
    // release stale queue/job locks so a crash mid-sync can't stall every
    // MAIN_QUEUE job until graphile-worker's 4-hour stale-lock sweep.
    await recoverOrphanedWorkerLocks(pgPool).catch((error) => {
      logger.error("Jobs", "Failed to recover orphaned worker locks", { error: String(error) });
    });

    runner = await run({
      pgPool,
      concurrency: 3,
      // Let Graphile install SIGTERM/SIGINT handlers for graceful shutdown.
      noHandleSignals: false,
      pollInterval: 10_000,
      taskList,
      parsedCronItems: parseCrontab(CRONTAB),
    });

    // Surface unexpected runner termination; don't let the rejection go
    // unhandled. Reset both handles so a later startWorker() can restart it.
    runner.promise.catch((error) => {
      logger.error("Jobs", "Graphile worker stopped unexpectedly", { error: String(error) });
      runner = undefined;
      startPromise = undefined;
    });

    logger.info("Jobs", "Graphile worker started — dispatcher checking every minute");
  })();

  try {
    await startPromise;
  } catch (error) {
    startPromise = undefined;
    logger.error("Jobs", "Failed to start Graphile worker", { error: String(error) });
    throw error;
  }
}

/** Gracefully stop the worker runner (used in shutdown paths and tests). */
export async function stopWorker(): Promise<void> {
  if (runner) {
    await runner.stop().catch(() => {});
    runner = undefined;
  }
  startPromise = undefined;
}
