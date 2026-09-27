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
 * done.
 *
 * Scoped by rule set id for the two rule-set routes (a force-retry during an
 * Execute of the same rule set is the same hazard) and by `query:<userId>` for
 * the ad-hoc route, whose client batches a large selection into SEQUENTIAL
 * requests, so one key per user never blocks a legitimate batch. Within a
 * rule set a run holds either the WHOLE scope (Execute All, which acts on
 * every match) or only the items it names (a per-item Execute, a force-retry):
 * the hazard is two runs acting on the same match at once, and a scope-wide
 * lock made the Pending page's per-item Execute buttons — which run side by
 * side on different items — answer 409 to one another. Runs of disjoint items
 * are no more a hazard together than one after the other: the copies of one
 * title are collapsed into one match whenever an action is armed, and two
 * different matches that still resolve to one Arr record (two tracks under a
 * whole-artist delete) meet the same record in sequence too, which this lock
 * never covered.
 *
 * In-process on purpose: a lock that dies with the process is a lock whose
 * holder is no longer running. Pinned to `globalThis` unconditionally, the
 * same way as `eventBus` and the realtime self-write registry — the routes
 * are reached through route bundles and Next.js dev HMR re-evaluates modules,
 * and two copies of this registry would let two requests through.
 *
 * Dependency-free so the routes can import it without dragging in anything
 * else.
 */

/** What is running in one scope right now. */
interface ScopeHolders {
  /** A run holds the whole scope. */
  whole: boolean;
  /** Items held by runs that named them; never overlapping, see `tryBeginExecute`. */
  items: Set<string>;
}

const globalForExecute = globalThis as unknown as {
  lifecycleExecuteInFlightScopes: Map<string, ScopeHolders> | undefined;
};

/** Scopes with an execution running right now. */
const inFlight: Map<string, ScopeHolders> =
  globalForExecute.lifecycleExecuteInFlightScopes ?? new Map<string, ScopeHolders>();
globalForExecute.lifecycleExecuteInFlightScopes = inFlight;

/** The lock key for an ad-hoc query action run — one per user, not per request. */
export function queryExecuteKey(userId: string): string {
  return `query:${userId}`;
}

function wantsWholeScope(itemIds: readonly string[] | undefined): itemIds is undefined {
  return itemIds === undefined || itemIds.length === 0;
}

/**
 * Claim `scope` — all of it when `itemIds` is omitted (or empty), otherwise
 * only those items. A whole-scope claim is refused while anything in the scope
 * runs; an item claim is refused while the whole scope is held or any of its
 * items is. Returns `false`, changing nothing, on a refusal — the caller must
 * then answer 409 and must NOT call `endExecute`.
 */
export function tryBeginExecute(scope: string, itemIds?: readonly string[]): boolean {
  const held = inFlight.get(scope);
  if (wantsWholeScope(itemIds)) {
    if (held && (held.whole || held.items.size > 0)) return false;
    inFlight.set(scope, { whole: true, items: new Set() });
    return true;
  }
  if (held?.whole) return false;
  if (held && itemIds.some((id) => held.items.has(id))) return false;
  const entry = held ?? { whole: false, items: new Set<string>() };
  for (const id of itemIds) entry.items.add(id);
  inFlight.set(scope, entry);
  return true;
}

/**
 * Release what `tryBeginExecute(scope, itemIds)` claimed — pass the same
 * `itemIds`. Always call from a `finally` that covers every exit.
 */
export function endExecute(scope: string, itemIds?: readonly string[]): void {
  const held = inFlight.get(scope);
  if (!held) return;
  if (wantsWholeScope(itemIds)) held.whole = false;
  else for (const id of itemIds) held.items.delete(id);
  if (!held.whole && held.items.size === 0) inFlight.delete(scope);
}

/** Test-only: release every scope. */
export function _resetExecuteInFlightForTesting(): void {
  inFlight.clear();
}
