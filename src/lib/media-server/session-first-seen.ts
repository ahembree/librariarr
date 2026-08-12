/**
 * Process-wide "when did we first see this session" tracking, shared by the
 * sessions SSE stream and the one-shot sessions list route so they agree on
 * each stream's start time.
 *
 * Previously each route kept its own map; the list route stamped `now` on every
 * call, so hitting it (e.g. a manual refresh) reset the displayed duration of
 * streams the SSE route had been timing. Sharing one map keeps the value
 * stable across both.
 *
 * Keyed "serverId:sessionId". Not persisted — a restart resets durations, which
 * is acceptable for a live view.
 */
const firstSeen = new Map<string, number>();

function keyFor(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

/** Record (if new) and return the first-seen timestamp for a session. */
export function stampFirstSeen(serverId: string, sessionId: string, now: number): number {
  const key = keyFor(serverId, sessionId);
  const existing = firstSeen.get(key);
  if (existing !== undefined) return existing;
  firstSeen.set(key, now);
  return now;
}

/**
 * Drop entries for sessions that have genuinely ended, without discarding
 * timers for servers that were merely unreachable this cycle.
 *
 * - `activeKeys`: "serverId:sessionId" keys observed this cycle.
 * - `knownServerIds`: servers that still exist/enabled — entries for others are
 *   dropped outright (they can never match again).
 * - `polledServerIds`: servers actually reached this cycle. An entry whose
 *   server was NOT polled is kept (a failed poll must not look like the stream
 *   ended and reset its duration on recovery).
 */
export function pruneFirstSeen(
  activeKeys: Set<string>,
  knownServerIds: Set<string>,
  polledServerIds: Set<string>,
): void {
  for (const key of firstSeen.keys()) {
    const serverId = key.slice(0, key.indexOf(":"));
    if (!knownServerIds.has(serverId)) {
      firstSeen.delete(key);
      continue;
    }
    if (!polledServerIds.has(serverId)) continue;
    if (!activeKeys.has(key)) firstSeen.delete(key);
  }
}

/** Test helper. */
export function _resetFirstSeen(): void {
  firstSeen.clear();
}
