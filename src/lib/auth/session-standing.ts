import { prisma } from "@/lib/db";

/**
 * Revocation for responses that outlive the request that opened them.
 *
 * `getSession()` checks a cookie against the User row once, when the request
 * arrives. An SSE stream then stays open for up to an hour: signing out
 * everywhere or changing the password bumped `sessionVersion`, every later
 * request with the old cookie was refused — and a stream it had already opened
 * kept delivering (playback sessions with usernames, player addresses and file
 * paths; every app event) until its lifetime ran out. A stream re-reads the
 * row on a timer and ends itself once the session it was opened with is gone.
 *
 * That includes the admin's OWN streams after they change the password or
 * unlink SSO in the same browser: the route bumps the version and re-seals
 * that browser's cookie with the new one, but a stream holds the version it
 * was opened with — and so does a stream opened from a stolen copy of the old
 * cookie, which is exactly what the change is meant to cut off. The two cannot
 * be told apart here, so both end; the browser with the new cookie reconnects
 * on its own (`EventSource`, and `useRealtime` refetches on a re-open).
 */
export type SessionStanding = "current" | "revoked" | "unknown";

/** How often an open stream re-checks the session it was opened with. */
export const SESSION_RECHECK_INTERVAL_MS = 30_000;

/**
 * Whether the session a stream was opened with is still honoured. `unknown`
 * is a database error: the stream is kept and asked again on the next tick —
 * only a row that was read and disagrees ends it, so a database blip does not
 * drop every open stream.
 */
export async function sessionStanding(
  userId: string | undefined,
  sessionVersion: number | undefined,
): Promise<SessionStanding> {
  if (!userId || sessionVersion === undefined) return "revoked";
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    return user && user.sessionVersion === sessionVersion ? "current" : "revoked";
  } catch {
    return "unknown";
  }
}

/**
 * Call `end` once the session is revoked. Returns the function that stops
 * watching (call it from the stream's own teardown).
 */
export function endWhenSessionRevoked(
  session: { userId?: string; sessionVersion?: number },
  end: () => void,
  intervalMs: number = SESSION_RECHECK_INTERVAL_MS,
): () => void {
  // Read once: the session object belongs to a request that has returned.
  const { userId, sessionVersion } = session;
  let stopped = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      if ((await sessionStanding(userId, sessionVersion)) === "revoked" && !stopped) {
        stopped = true;
        clearInterval(timer);
        end();
      }
    } finally {
      checking = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
