import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  currentSsoIssuer,
  getSsoSettings,
  isSsoOverrideActive,
  isSsoUsable,
  type SsoSettings,
} from "@/lib/sso/config";
import { RECENT_LOGIN_WINDOW_MS } from "@/lib/auth/recent-login";
import { passwordSignInEnabled } from "@/lib/auth/password-sign-in";
import type { ReauthMethod } from "@/lib/auth/reauth-client";

export type { ReauthMethod } from "@/lib/auth/reauth-client";

/**
 * A re-authentication handshake's `state` is `<random>.<nonce>`: the random
 * part is what the callback verifies, the nonce what its report to the popup
 * page carries. `generateState()` is base64url, so it never contains a dot.
 */
export const REAUTH_STATE_SEPARATOR = ".";

/** The attempt nonce carried in a re-authentication `state`, if any. */
export function reauthNonceFromState(state: string | null): string | undefined {
  if (!state) return undefined;
  const nonce = state.slice(state.lastIndexOf(REAUTH_STATE_SEPARATOR) + 1);
  return state.includes(REAUTH_STATE_SEPARATOR) && /^[A-Za-z0-9_-]{16,64}$/.test(nonce) ? nonce : undefined;
}

/**
 * Re-authentication in place. Actions guarded by `hasRecentLogin`
 * (recent-login.ts) used to leave an account one option: sign out, sign back
 * in, and redo the action inside the window. These methods confirm the
 * identity without leaving the page and stamp `session.authenticatedAt`,
 * exactly as a fresh login would. The browser side is reauth-client.ts
 * (`fetchWithReauth`).
 *
 * - `password`: the account's current password (`POST /api/auth/reauth/password`)
 *   — offered only while password sign-in is on (password-sign-in.ts), since
 *   the login would refuse it otherwise.
 * - `plex`: a Plex OAuth round-trip whose Plex account is the one linked to
 *   this user (`POST /api/auth/reauth/plex`) — offered only while Plex sign-in
 *   is allowed, since that is what `/api/auth/plex/token` requires for a login.
 * - `oidc`: an OIDC round-trip (with `prompt=login`, in a popup) whose subject
 *   is the one linked to this user (`POST /api/auth/reauth/oidc`, finished by
 *   the OIDC callback, which returns the popup to `/login/reauth`).
 * - `forward`: the forward-auth proxy's identity header naming the linked
 *   subject — the same proof a forward-auth login accepts
 *   (`POST /api/auth/reauth/forward`).
 *
 * Each method is offered exactly where its route accepts it: every route
 * checks `loadReauthContext(...).methods` before looking at the proof.
 */

interface SsoLink {
  ssoEnabled: boolean;
  ssoSubject: string | null;
  ssoIssuer: string | null;
}

/**
 * The user has an SSO identity linked under the configured issuer. A null
 * stored issuer is a link made before the column existed, which login accepts
 * too (and backfills).
 */
export function ssoLinkedToIssuer(user: SsoLink, issuer: string | null): boolean {
  if (!user.ssoEnabled || !user.ssoSubject || !issuer) return false;
  return user.ssoIssuer === null || user.ssoIssuer === issuer;
}

/** `subject` is the SSO identity linked to this user under the configured issuer. */
export function ssoIdentityMatches(user: SsoLink, subject: string, issuer: string | null): boolean {
  return ssoLinkedToIssuer(user, issuer) && user.ssoSubject === subject;
}

export interface ReauthContext {
  /** Plex, then SSO, then password — the order the prompt lists them in. */
  methods: ReauthMethod[];
  /** The SSO configuration the methods were derived from. */
  sso: SsoSettings | null;
}

/** Which ways this user can confirm their identity in place. */
export async function loadReauthContext(userId: string): Promise<ReauthContext> {
  const [user, settings, sso] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { plexId: true, passwordHash: true, ssoEnabled: true, ssoSubject: true, ssoIssuer: true },
    }),
    prisma.appSettings.findFirst({ select: { plexLoginEnabled: true, localAuthEnabled: true } }),
    getSsoSettings(),
  ]);
  if (!user) return { methods: [], sso };

  const methods: ReauthMethod[] = [];
  // Plex sign-in can be turned off because a household shares one Plex
  // account; then a Plex round-trip proves nothing about who is at the
  // keyboard, here any more than at login. SSO_DISABLE_OVERRIDE re-opens Plex
  // login, so it re-opens this too.
  if (user.plexId && (settings?.plexLoginEnabled !== false || isSsoOverrideActive())) {
    methods.push("plex");
  }
  if (sso && isSsoUsable(sso) && ssoLinkedToIssuer(user, currentSsoIssuer(sso))) {
    methods.push(sso.ssoMode === "OIDC" ? "oidc" : "forward");
  }
  // The password only while password sign-in is on — the login's own rule
  // (password-sign-in.ts). With local login off, or SSO replacing it, the
  // password is accepted for nothing, here included.
  if (user.passwordHash && passwordSignInEnabled({ localAuthEnabled: settings?.localAuthEnabled, sso })) {
    methods.push("password");
  }
  return { methods, sso };
}

/**
 * The 403 for an action whose sign-in is older than the window, naming the
 * methods the client can offer to renew it in place. With none available the
 * only way left is signing in again — unless SSO is what the login page
 * offers, since then no method at all means SSO does not recognise this
 * account's link (password sign-in is off while SSO is usable, and Plex
 * sign-in is off or unlinked): signing out would lock the admin out.
 */
export async function reauthRequired(userId: string, what: string): Promise<NextResponse> {
  const minutes = Math.round(RECENT_LOGIN_WINDOW_MS / 60_000);
  const { methods, sso } = await loadReauthContext(userId);
  const needs = `${what} needs a sign-in from the last ${minutes} minutes.`;
  const error =
    methods.length > 0
      ? `${needs} Confirm it's you to continue.`
      : isSsoUsable(sso)
        ? `${needs} Don't sign out: SSO does not recognise this account's linked identity, so you could not sign back in. See SSO_DISABLE_OVERRIDE in the SSO documentation to sign in another way first.`
        : `${needs} Sign out, sign back in, then try again.`;
  return NextResponse.json({ error, code: "reauth_required", methods }, { status: 403 });
}
