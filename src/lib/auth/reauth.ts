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
import type { ReauthMethod } from "@/lib/auth/reauth-client";

export type { ReauthMethod } from "@/lib/auth/reauth-client";

/**
 * Re-authentication in place. Actions guarded by `hasRecentLogin`
 * (recent-login.ts) used to leave an account one option: sign out, sign back
 * in, and redo the action inside the window. These methods confirm the
 * identity without leaving the page and stamp `session.authenticatedAt`,
 * exactly as a fresh login would. The browser side is reauth-client.ts
 * (`fetchWithReauth`).
 *
 * - `password`: the account's current password (`POST /api/auth/reauth/password`).
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
    prisma.appSettings.findFirst({ select: { plexLoginEnabled: true } }),
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
  // The password is accepted wherever it exists, as the API-key step-up and
  // the password change already accept it.
  if (user.passwordHash) methods.push("password");
  return { methods, sso };
}

export async function getReauthMethods(userId: string): Promise<ReauthMethod[]> {
  return (await loadReauthContext(userId)).methods;
}

/**
 * The 403 for an action whose sign-in is older than the window, naming the
 * methods the client can offer to renew it in place. With none available the
 * only way left is signing in again.
 */
export async function reauthRequired(userId: string, what: string): Promise<NextResponse> {
  const minutes = Math.round(RECENT_LOGIN_WINDOW_MS / 60_000);
  const methods = await getReauthMethods(userId);
  const error =
    methods.length > 0
      ? `${what} needs a sign-in from the last ${minutes} minutes. Confirm it's you to continue.`
      : `${what} needs a sign-in from the last ${minutes} minutes. Sign out, sign back in, then try again.`;
  return NextResponse.json({ error, code: "reauth_required", methods }, { status: 403 });
}
