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
 * The last detail seen for each session, so a caller holding only a session id
 * can name the viewer and the media without a round-trip of its own.
 *
 * The terminate route is the consumer: a termination log has to say who was
 * watching what, and the ids it is given carry neither. Fetching the session
 * list there instead would be a network call whose FAILURE is the problem —
 * `configureRetry` opens the shared per-baseURL circuit breaker on the first
 * network error (`markUnreachable`), after which the termination request that
 * follows is rejected by the request interceptor without reaching the server.
 * Paying a round-trip for a log label must never cost the operator the ability
 * to stop a stream, so the label is read from what the listing routes already
 * fetched.
 */
const lastDetail = new Map<string, MediaSession>();

/**
 * Bound on `lastDetail`. `pruneFirstSeen` runs only from the sessions SSE
 * stream, so a process where nobody opens the Stream Manager (the sidebar
 * polls the list route on its own) never prunes — and unlike `firstSeen`'s
 * numbers these entries are whole session objects. Far above any real
 * concurrent-stream count, so eviction only ever touches entries pruning
 * would have taken anyway.
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
  const key = keyFor(serverId, session.sessionId);
  // Re-insert so a live session is always the newest entry and can never be
  // the one evicted below.
  lastDetail.delete(key);
  lastDetail.set(key, session);
  while (lastDetail.size > MAX_REMEMBERED) {
    const oldest = lastDetail.keys().next();
    if (oldest.done) break;
    lastDetail.delete(oldest.value);
  }
}

/**
 * The last detail seen for a session, or undefined when neither listing route
 * has observed it (a cold process, or a caller that never listed).
 */
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
  // Both maps are keyed and aged identically — an entry that is no longer a
  // live session must not keep a stale label alive either.
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
