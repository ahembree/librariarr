import { NextResponse } from "next/server";

/**
 * How recent a sign-in must be for an action that adds a lasting way into the
 * account without proving the current password:
 *
 * - creating an API key on an account with no local password,
 * - setting the account's first local password,
 * - linking a Plex account,
 * - linking an SSO identity.
 *
 * Each outlives the cookie session that performs it. Logging out and changing
 * the password revoke sessions, not a key, a password or a linked identity, so
 * a stolen cookie must not be enough on its own. The checks close each other's
 * gaps: when only API-key creation asked for a recent sign-in, a stolen cookie
 * set a first password and then created the key with that password.
 *
 * Every login path goes through `rotateSession()`, which stamps
 * `authenticatedAt` (epoch ms). A session from before that stamp existed has
 * none and reads as not recent.
 */
export const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function hasRecentLogin(session: { authenticatedAt?: number }, now = Date.now()): boolean {
  return typeof session.authenticatedAt === "number" && now - session.authenticatedAt <= RECENT_LOGIN_WINDOW_MS;
}

/**
 * The 403 for a session whose sign-in is older than the window. The message
 * reads "<what> needs a sign-in from the last 15 minutes. Sign out, sign back
 * in, then <then>." — the settings page shows `error` as it is.
 */
export function recentLoginRequired(what: string, then: string): NextResponse {
  const minutes = Math.round(RECENT_LOGIN_WINDOW_MS / 60_000);
  return NextResponse.json(
    {
      error: `${what} needs a sign-in from the last ${minutes} minutes. Sign out, sign back in, then ${then}.`,
      code: "reauth_required",
    },
    { status: 403 },
  );
}
