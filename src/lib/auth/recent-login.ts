/**
 * How recent a sign-in must be for an action that adds a lasting way into the
 * account without proving the current password:
 *
 * - creating an API key on an account with no local password,
 * - setting the account's first local password,
 * - linking a Plex account,
 * - linking an SSO identity,
 *
 * and for an action that hands over or replaces a credential that signs in:
 *
 * - creating, downloading or restoring a backup (`/api/backup`,
 *   `/api/backup/[filename]`, `/api/backup/restore`) — a backup holds
 *   `User.plexToken` and every Plex server's access token, and the caller may
 *   choose the passphrase it is encrypted with,
 * - adding a Plex server by machine id, whose access token the server looks up
 *   on plex.tv and sends to the URL in the request (`POST /api/servers`),
 * - pointing a Plex server at a new URL while its stored token stays
 *   (`PUT /api/servers/[id]`), which sends that token to the new URL.
 *
 * Each outlives the cookie session that performs it. Logging out and changing
 * the password revoke sessions, not a key, a password or a linked identity, so
 * a stolen cookie must not be enough on its own. The checks close each other's
 * gaps: when only API-key creation asked for a recent sign-in, a stolen cookie
 * set a first password and then created the key with that password; and
 * because `POST /api/auth/plex/token` signs in with a bare Plex token (stamping
 * a fresh `authenticatedAt`), any route that lets a cookie read a Plex token
 * would pass every check here — a stolen cookie made a backup with a passphrase
 * of its choosing, downloaded it, signed in with the `plexToken` inside, and
 * created an API key. Asking for a Plex PIN instead of a bare token would not
 * stop that: plex.tv links a PIN to whichever account presents a token
 * (`PUT /api/v2/pins/link`), so the token has to stay out of a stale cookie's
 * reach instead.
 *
 * Every login path goes through `rotateSession()`, which stamps
 * `authenticatedAt` (epoch ms). A session from before that stamp existed has
 * none and reads as not recent. A refusal goes out through `reauthRequired`
 * (reauth.ts), which names the ways to renew it in place — the password,
 * Plex, OIDC or the forward-auth proxy — so nobody has to sign out and back
 * in.
 */
export const RECENT_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function hasRecentLogin(session: { authenticatedAt?: number }, now = Date.now()): boolean {
  return typeof session.authenticatedAt === "number" && now - session.authenticatedAt <= RECENT_LOGIN_WINDOW_MS;
}
