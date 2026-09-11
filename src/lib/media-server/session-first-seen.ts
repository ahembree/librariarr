import type { MediaSession } from "./types";

/**
 * Process-wide per-session tracking, shared by the sessions SSE stream and the
 * one-shot sessions list route: when each session was first seen, and the last
 * detail either route observed for it.
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

/**
 * The last detail seen for each session, so the terminate route can name the
 * viewer and the media from a session id alone. Fetching the session list there
 * instead would be a network call whose FAILURE is the problem: it opens the
 * shared per-baseURL circuit breaker, after which the termination that follows
 * is rejected without reaching the server. A log label must never cost the
 * operator the ability to stop a stream.
 */
const lastDetail = new Map<string, MediaSession>();

/**
 * Bound on `lastDetail`. Only the SSE stream prunes, so a process where nobody
 * opens the Stream Manager never does — and these entries are whole session
 * objects, not `firstSeen`'s numbers. Far above any real concurrent-stream
 * count.
 */
const MAX_REMEMBERED = 500;

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

/** Record the latest detail seen for a session. */
export function rememberSession(serverId: string, session: MediaSession): void {
  lastDetail.set(keyFor(serverId, session.sessionId), session);
  if (lastDetail.size > MAX_REMEMBERED) {
    // Oldest first — an evicted live session is re-added by the next poll.
    const oldest = lastDetail.keys().next();
    if (!oldest.done) lastDetail.delete(oldest.value);
  }
}

/** The last detail seen for a session, or undefined if nothing has listed it. */
export function getRememberedSession(
  serverId: string,
  sessionId: string,
): MediaSession | undefined {
  return lastDetail.get(keyFor(serverId, sessionId));
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
  // Both maps are keyed and aged identically.
  for (const key of new Set([...firstSeen.keys(), ...lastDetail.keys()])) {
    const serverId = key.slice(0, key.indexOf(":"));
    if (!knownServerIds.has(serverId)) {
      firstSeen.delete(key);
      lastDetail.delete(key);
      continue;
    }
    if (!polledServerIds.has(serverId)) continue;
    if (!activeKeys.has(key)) {
      firstSeen.delete(key);
      lastDetail.delete(key);
    }
  }
}

/** Test helper. */
export function _resetFirstSeen(): void {
  firstSeen.clear();
  lastDetail.clear();
}
