import { Pool } from "pg";
import { makeWorkerUtils, type WorkerUtils, type TaskSpec } from "graphile-worker";
import { logger } from "@/lib/logger";

/**
 * Shared client-side plumbing for enqueueing background jobs.
 *
 * The worker runner ({@link ./worker}) and this enqueue helper both connect to
 * the same Postgres database via a dedicated `pg.Pool` (separate from Prisma's
 * pool, since Graphile Worker manages its own connections and LISTEN/NOTIFY).
 */

let pool: Pool | undefined;

/** Lazily create the shared pg Pool used by Graphile Worker. */
export function getJobsPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    // Attach error handlers so a dropped backend connection can't crash the
    // process (recommended by the graphile-worker docs).
    const handleError = () => {};
    pool.on("error", handleError);
    pool.on("connect", (client) => client.on("error", handleError));
  }
  return pool;
}

let workerUtils: WorkerUtils | undefined;
let workerUtilsPromise: Promise<WorkerUtils> | undefined;

async function getWorkerUtils(): Promise<WorkerUtils> {
  if (workerUtils) return workerUtils;
  if (!workerUtilsPromise) {
    workerUtilsPromise = makeWorkerUtils({ pgPool: getJobsPool() }).then((utils) => {
      workerUtils = utils;
      return utils;
    });
  }
  return workerUtilsPromise;
}

/**
 * Enqueue a background job. Errors are logged rather than thrown so that
 * fire-and-forget callers (API routes, the dispatcher) are never blocked by a
 * transient queue failure. Returns `true` on success and `false` on failure so
 * callers that advance a schedule watermark can avoid skipping a window when
 * the enqueue silently failed.
 */
export async function enqueueJob(
  identifier: string,
  payload: unknown,
  spec?: TaskSpec,
): Promise<boolean> {
  try {
    const utils = await getWorkerUtils();
    await utils.addJob(identifier, payload, spec);
    return true;
  } catch (error) {
    logger.error("Jobs", `Failed to enqueue job "${identifier}"`, { error: String(error) });
    return false;
  }
}

/** Release pooled resources. Primarily used by tests. */
export async function releaseJobsClient(): Promise<void> {
  if (workerUtils) {
    await Promise.resolve(workerUtils.release()).catch(() => {});
    workerUtils = undefined;
    workerUtilsPromise = undefined;
  }
  if (pool) {
    await pool.end().catch(() => {});
    pool = undefined;
  }
}
