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
    await utils.addJob(identifier, payload, await keepQueuedPriority(spec));
    return true;
  } catch (error) {
    logger.error("Jobs", `Failed to enqueue job "${identifier}"`, { error: String(error) });
    return false;
  }
}

/**
 * Never let a keyed enqueue make an already-queued job less urgent.
 *
 * graphile-worker's default `replace` mode overwrites the queued job's priority
 * with the new spec's. A sync the user requested from Settings is queued at
 * `REQUESTED_SYNC_PRIORITY` under `sync:<serverId>` — the same key the
 * scheduler, the realtime layer and the incremental-sync fallback use at the
 * default 0 — so any of them firing while it waited demoted it back behind
 * every background job already queued. Keeps the queued job's priority when it
 * is the more urgent one.
 *
 * Best-effort: a failed lookup enqueues with the caller's spec unchanged, as
 * before, rather than failing the enqueue. The lookup and the add are not
 * atomic, which only matters if a more urgent job is queued under the same key
 * in between — the same outcome the replace had without this.
 */
async function keepQueuedPriority(spec: TaskSpec | undefined): Promise<TaskSpec | undefined> {
  if (!spec?.jobKey) return spec;
  try {
    const { rows } = await getJobsPool().query<{ priority: number }>(
      `SELECT "priority" FROM graphile_worker.jobs WHERE "key" = $1 AND "locked_at" IS NULL`,
      [spec.jobKey],
    );
    const queued = rows[0]?.priority;
    if (queued !== undefined && queued < (spec.priority ?? 0)) return { ...spec, priority: queued };
  } catch (error) {
    logger.warn("Jobs", `Could not read the queued priority for "${spec.jobKey}"`, { error: String(error) });
  }
  return spec;
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
