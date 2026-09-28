import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentSsoIssuer, getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import { RECENT_LOGIN_WINDOW_MS } from "@/lib/auth/recent-login";

/**
 * Re-authentication for an account with no local password. Actions guarded by
 * `hasRecentLogin` (recent-login.ts) used to leave such an account one option:
 * sign out, sign back in, and redo the action inside the window. These
 * methods confirm the identity in place instead and stamp
 * `session.authenticatedAt`, exactly as a fresh login would.
 *
 * - `plex`: a Plex OAuth round-trip whose Plex account is the one linked to
 *   this user (`POST /api/auth/reauth/plex`).
 * - `oidc`: an OIDC round-trip (with `prompt=login`) whose subject is the one
 *   linked to this user (`POST /api/auth/reauth/oidc`, finished by the OIDC
 *   callback).
 * - `forward`: the forward-auth proxy's identity header naming the linked
 *   subject — the same proof a forward-auth login accepts
 *   (`POST /api/auth/reauth/forward`).
 */
export type ReauthMethod = "plex" | "oidc" | "forward";

/** The linked SSO subject matches the currently configured issuer. */
export function ssoIdentityMatches(
  user: { ssoEnabled: boolean; ssoSubject: string | null; ssoIssuer: string | null },
  subject: string,
  issuer: string | null,
): boolean {
  if (!user.ssoEnabled || !user.ssoSubject || !issuer) return false;
  if (user.ssoSubject !== subject) return false;
  return user.ssoIssuer === null || user.ssoIssuer === issuer;
}

/** Which ways this user can confirm their identity without a password. */
export async function getReauthMethods(userId: string): Promise<ReauthMethod[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plexId: true, ssoEnabled: true, ssoSubject: true, ssoIssuer: true },
  });
  if (!user) return [];

  const methods: ReauthMethod[] = [];
  if (user.plexId) methods.push("plex");

  const settings = await getSsoSettings();
  if (settings && isSsoUsable(settings) && user.ssoEnabled && user.ssoSubject) {
    const issuer = currentSsoIssuer(settings);
    if (issuer && (user.ssoIssuer === null || user.ssoIssuer === issuer)) {
      methods.push(settings.ssoMode === "OIDC" ? "oidc" : "forward");
    }
  }
  return methods;
}

/**
 * The 403 for an account with no local password whose sign-in is older than
 * the window, naming the methods the client can offer to confirm it in place.
 * With none available the only way left is signing in again.
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
