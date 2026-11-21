import { isTruthyFlag } from "@/lib/env-flag";

/**
 * The OIDC handshake a session carries between the redirect to the identity
 * provider and the callback: `state`, the PKCE verifier, which flow it is, and
 * when it began.
 *
 * It used to have no age. A handshake that was started and abandoned — the
 * popup closed, the IdP tab left open — stayed in the 30-day cookie, so the
 * "link an SSO identity" step, which needs a recent sign-in to START, could be
 * FINISHED weeks later by whoever held a copy of that cookie and the
 * authorization URL: their own account at the IdP became the admin's linked
 * identity. A handshake is now good for ten minutes, the time the waiting
 * page gives it (`OIDC_TIMEOUT_MS`, reauth-client.ts).
 */
export const OIDC_HANDSHAKE_TTL_MS = 10 * 60 * 1000;

export interface OidcHandshakeFields {
  oidcState?: string;
  oidcVerifier?: string;
  oidcFlow?: "link" | "reauth";
  oidcStartedAt?: number;
}

/** Write a new handshake into the session (the caller saves it). */
export function beginOidcHandshake(
  session: OidcHandshakeFields,
  handshake: { state: string; verifier: string; flow?: "link" | "reauth" },
): void {
  session.oidcState = handshake.state;
  session.oidcVerifier = handshake.verifier;
  session.oidcFlow = handshake.flow;
  session.oidcStartedAt = Date.now();
}

/** Remove every handshake field (the caller saves the session). */
export function clearOidcHandshake(session: OidcHandshakeFields): void {
  session.oidcState = undefined;
  session.oidcVerifier = undefined;
  session.oidcFlow = undefined;
  session.oidcStartedAt = undefined;
}

/** Whether a handshake that began at `startedAt` may still be completed. */
export function isOidcHandshakeFresh(startedAt: number | undefined, now = Date.now()): boolean {
  return typeof startedAt === "number" && startedAt <= now && now - startedAt <= OIDC_HANDSHAKE_TTL_MS;
}

/**
 * How far behind ours an identity provider's clock may run and still have its
 * `auth_time` read as "after this confirmation began".
 */
export const OIDC_AUTH_TIME_SKEW_MS = 5 * 60 * 1000;

export const OIDC_REAUTH_ALLOW_UNVERIFIED_ENV = "OIDC_REAUTH_ALLOW_UNVERIFIED";

/**
 * Whether an OIDC confirmation whose provider did not say when the user
 * authenticated is accepted anyway (`OIDC_REAUTH_ALLOW_UNVERIFIED=true`).
 * For a provider that ignores `max_age` and never sends `auth_time`; with it
 * on, "Confirm it's you" through OIDC proves only that the provider still has
 * a session for the linked identity.
 */
export function allowsUnverifiedOidcReauth(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthyFlag(env[OIDC_REAUTH_ALLOW_UNVERIFIED_ENV]);
}

export type ReauthFreshness = "fresh" | "stale" | "unknown";

/**
 * Whether the identity provider authenticated the user for THIS confirmation.
 *
 * The confirmation asks for `prompt=login` and `max_age=0`, but both travel
 * through the browser: whoever is driving it can drop them from the URL, and a
 * provider with a live session then answers at once, nobody having typed
 * anything. The ID token's `auth_time` comes straight from the token endpoint
 * and cannot be edited that way. `max_age` obliges the provider to send it
 * (OpenID Connect Core §3.1.2.1), so its absence means the parameter was
 * stripped or the provider does not implement it — `unknown`, refused unless
 * the operator opted out above.
 */
export function reauthFreshness(
  authTimeSeconds: number | undefined,
  handshakeStartedAt: number | undefined,
): ReauthFreshness {
  if (typeof authTimeSeconds !== "number" || !Number.isFinite(authTimeSeconds)) return "unknown";
  if (typeof handshakeStartedAt !== "number") return "stale";
  return authTimeSeconds * 1000 >= handshakeStartedAt - OIDC_AUTH_TIME_SKEW_MS ? "fresh" : "stale";
}
