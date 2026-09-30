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
 * none and reads as not recent. A refusal goes out through `reauthRequired`
 * (reauth.ts), which names the ways to renew it in place — Plex, OIDC or the
 * forward-auth proxy — so nobody has to sign out and back in.
 */
export const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function hasRecentLogin(session: { authenticatedAt?: number }, now = Date.now()): boolean {
  return typeof session.authenticatedAt === "number" && now - session.authenticatedAt <= RECENT_LOGIN_WINDOW_MS;
}
