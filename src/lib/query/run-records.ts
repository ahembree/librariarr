/**
 * The Arr records a multi-batch query action run has already acted on, by run.
 *
 * The Query page sends a large selection as sequential requests sharing one
 * `runId`, and a whole-record action must not reach the same Arr record twice
 * across them — two servers' copies of one movie can land in different
 * batches. This is a deletion-safety rule, so it lives in its own store rather
 * than `appCache`, whose bounded store evicts its oldest entries under load:
 * an evicted entry would let a later batch re-send a delete.
 *
 * Pinned to `globalThis` like the other registries the route bundle shares
 * (see "Cross-bundle singletons" in CLAUDE.md). Entries expire with the run.
 */
const RUN_TTL_MS = 10 * 60 * 1000;

interface RunRecords {
  keys: Set<string>;
  expiresAt: number;
}

const globalForRunRecords = globalThis as unknown as { queryRunRecords?: Map<string, RunRecords> };
const runs = (globalForRunRecords.queryRunRecords ??= new Map<string, RunRecords>());

function prune(now: number): void {
  for (const [runId, entry] of runs) if (entry.expiresAt <= now) runs.delete(runId);
}

/** The records an earlier batch of `runId` acted on (empty for a new run). */
export function actedRecords(runId: string, now: number = Date.now()): ReadonlySet<string> {
  prune(now);
  return runs.get(runId)?.keys ?? new Set();
}

/** Record that this batch is acting on `keys`; refreshes the run's expiry. */
export function markRecordsActed(runId: string, keys: Iterable<string>, now: number = Date.now()): void {
  prune(now);
  const entry = runs.get(runId) ?? { keys: new Set<string>(), expiresAt: 0 };
  for (const key of keys) entry.keys.add(key);
  entry.expiresAt = now + RUN_TTL_MS;
  runs.set(runId, entry);
}
