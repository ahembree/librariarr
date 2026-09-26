/**
 * Single-flight registry for the INLINE lifecycle execution paths: the manual
 * Execute route (`POST /api/lifecycle/actions/execute`, mirrored publicly as
 * `POST /api/v1/lifecycle/actions/execute`), force-retry
 * (`POST /api/lifecycle/actions/[id]`) and the ad-hoc query action route
 * (`POST /api/query/actions`).
 *
 * Exists because of a finding from a live security review of the public API.
 * Those routes run Arr deletions in the request — deliberately, since their
 * synchronous `{ executed, failed, errors }` response is the contract, and the
 * queued alternative already exists as `POST /api/v1/jobs/execution` — so
 * nothing serialised them: not `MAIN_QUEUE` (they run outside it), and not
 * the `RuleMatch` cleanup either, which happens AFTER the Arr call. N requests
 * for the same rule set that overlap therefore each load the same matches,
 * each send the same delete to Sonarr/Radarr/Lidarr, each record a COMPLETED
 * action with its own `deletedBytes` (double-counting the deletion stats),
 * and each fire the Discord failure summary for the ones the second delete
 * turned into a 404. A script holding a `lifecycle:execute` key can fire them
 * concurrently with no effort, and the UI's Execute button can be
 * double-clicked.
 *
 * The lock is held from the moment the target is loaded and ownership-checked
 * — BEFORE any side effect, including the disarm/deleteMany a refused request
 * performs — until the response is built, and a collision answers 409 rather
 * than waiting: the second caller wanted the same work done, and it is being
 * done. Keyed by rule set id for the two rule-set routes (a force-retry
 * during an Execute of the same rule set is the same hazard) and by
 * `query:<userId>` for the ad-hoc route, whose client batches a large
 * selection into SEQUENTIAL requests, so one key per user never blocks a
 * legitimate batch.
 *
 * In-process on purpose: a lock that dies with the process is a lock whose
 * holder is no longer running. Pinned to `globalThis` unconditionally, the
 * same way as `eventBus` and the realtime self-write registry — the routes
 * are reached through route bundles and Next.js dev HMR re-evaluates modules,
 * and two copies of this set would let two requests through.
 *
 * Dependency-free so the routes can import it without dragging in anything
 * else.
 */

const globalForExecute = globalThis as unknown as {
  lifecycleExecuteInFlight: Set<string> | undefined;
};

/** Keys with an execution running right now. */
const inFlight: Set<string> = globalForExecute.lifecycleExecuteInFlight ?? new Set<string>();
globalForExecute.lifecycleExecuteInFlight = inFlight;

/** The lock key for an ad-hoc query action run — one per user, not per request. */
export function queryExecuteKey(userId: string): string {
  return `query:${userId}`;
}

/**
 * Claim `key`. Returns `false`, changing nothing, when an execution already
 * holds it — the caller must then answer 409 and must NOT call `endExecute`.
 */
export function tryBeginExecute(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** Release `key`. Always call from a `finally` that covers every exit. */
export function endExecute(key: string): void {
  inFlight.delete(key);
}

/** True while `key` is held. */
export function isExecuteInFlight(key: string): boolean {
  return inFlight.has(key);
}

/** Test-only: release every key. */
export function _resetExecuteInFlightForTesting(): void {
  inFlight.clear();
}
