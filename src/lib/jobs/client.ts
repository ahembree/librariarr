import { Pool } from "pg";
import { makeWorkerUtils, type WorkerUtils, type TaskSpec } from "graphile-worker";
import { logger } from "@/lib/logger";
import { TASK_SYNC_WATCH_HISTORY, type SyncWatchHistoryPayload } from "@/lib/jobs/constants";

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
    const pending: Promise<WorkerUtils> = makeWorkerUtils({ pgPool: getJobsPool() }).then(
      (utils) => {
        workerUtils = utils;
        return utils;
      },
      (error: unknown) => {
        // Never cache a failure. Kept, a database that was briefly unreachable
        // at the first enqueue failed every later `enqueueJob` of this bundle
        // until a restart; cleared, the next call tries again. The callers
        // already waiting on this attempt see its error.
        if (workerUtilsPromise === pending) workerUtilsPromise = undefined;
        throw error;
      },
    );
    workerUtilsPromise = pending;
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
    const nextPayload = await keepQueuedFullReplace(identifier, payload, spec);
    await utils.addJob(identifier, nextPayload, await keepQueuedPriority(spec));
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

/**
 * Never let a keyed enqueue turn a queued full watch-history replace into an
 * incremental append.
 *
 * `/api/sync/by-type` queues a full replace under `watch-history:<serverId>` as
 * the deferred server-wide refresh for its per-library jobs; the realtime
 * manager queues `incremental: true` under the same key after a finished
 * playback. graphile-worker's default `replace` mode overwrites the queued
 * payload, so a play finishing while the full replace waited turned it into an
 * append, and the plays the server had since deleted were never reconciled.
 * The full replace re-reads every play, the new one included, so the incoming
 * enqueue keeps it and drops `incremental`.
 *
 * Only a job still waiting (`locked_at` NULL) is replaced; a running one gets a
 * fresh job beside it, which stays incremental. The payload lives on
 * graphile-worker's private table; its public view leaves it out.
 *
 * Best-effort, like {@link keepQueuedPriority}: a failed lookup enqueues the
 * payload unchanged rather than failing the enqueue, and the lookup and the add
 * are not atomic, which only matters if a full replace is queued under the same
 * key in between.
 */
async function keepQueuedFullReplace(
  identifier: string,
  payload: unknown,
  spec: TaskSpec | undefined,
): Promise<unknown> {
  if (identifier !== TASK_SYNC_WATCH_HISTORY || !spec?.jobKey) return payload;
  const next = payload as SyncWatchHistoryPayload;
  if (next?.incremental !== true) return payload;
  try {
    const { rows } = await getJobsPool().query<{ incremental: string | null }>(
      `SELECT "payload"->>'incremental' AS "incremental"
         FROM graphile_worker._private_jobs
        WHERE "key" = $1 AND "locked_at" IS NULL`,
      [spec.jobKey],
    );
    if (rows.length > 0 && rows[0].incremental !== "true") {
      const fullReplace: SyncWatchHistoryPayload = { ...next };
      delete fullReplace.incremental;
      return fullReplace;
    }
  } catch (error) {
    logger.warn("Jobs", `Could not read the queued watch-history refresh for "${spec.jobKey}"`, {
      error: String(error),
    });
  }
  return payload;
}

/**
 * The `syncJobId` each still-queued (not running) job under `jobKeys` carries,
 * by job key. A keyed enqueue replaces a queued job's payload, so a caller that
 * is about to re-enqueue under a key reuses the row that job was going to claim
 * instead of leaving it PENDING with nothing to claim it. The payload lives on
 * graphile-worker's private table; its public view leaves it out. `null` when
 * the lookup fails, so the caller can fall back rather than guess.
 */
export async function queuedSyncJobIds(jobKeys: string[]): Promise<Map<string, string> | null> {
  if (jobKeys.length === 0) return new Map();
  try {
    const { rows } = await getJobsPool().query<{ key: string; syncJobId: string | null }>(
      `SELECT "key", "payload"->>'syncJobId' AS "syncJobId"
         FROM graphile_worker._private_jobs
        WHERE "key" = ANY($1::text[]) AND "locked_at" IS NULL`,
      [jobKeys],
    );
    return new Map(rows.flatMap((row) => (row.syncJobId ? [[row.key, row.syncJobId] as const] : [])));
  } catch (error) {
    logger.warn("Jobs", "Could not read the queued sync jobs", { error: String(error) });
    return null;
  }
}

/**
 * Whether the job under `jobKey` failed and is waiting out graphile-worker's
 * retry backoff (attempted, not yet exhausted, not running).
 *
 * A keyed `addJob` always resets a queued job's `attempts` and `run_at`, so an
 * enqueue made while a job is backing off silently cancels the backoff and the
 * retry limit. Callers that re-enqueue a job on every routine run check this
 * first. A job that used up its attempts is NOT backing off — enqueueing it is
 * how it gets a fresh start. A failed check answers false, i.e. enqueue as
 * before.
 */
export async function isJobRetrying(jobKey: string): Promise<boolean> {
  try {
    const { rows } = await getJobsPool().query<{ retrying: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM graphile_worker.jobs
          WHERE "key" = $1 AND "locked_at" IS NULL
            AND "attempts" > 0 AND "attempts" < "max_attempts"
       ) AS "retrying"`,
      [jobKey],
    );
    return rows[0]?.retrying === true;
  } catch (error) {
    logger.warn("Jobs", `Could not read the retry state of "${jobKey}"`, { error: String(error) });
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
