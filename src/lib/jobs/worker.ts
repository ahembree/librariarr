import { run, parseCrontab, type Runner } from "graphile-worker";
import { logger } from "@/lib/logger";
import { getJobsPool } from "@/lib/jobs/client";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_DISPATCH, TASK_ARCHIVE_LOGS, TASK_CLEANUP_ACTIONS } from "@/lib/jobs/constants";

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
`.trim();

let runner: Runner | undefined;
let startPromise: Promise<void> | undefined;

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
    runner = await run({
      pgPool: getJobsPool(),
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
