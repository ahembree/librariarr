import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiLogger } from "@/lib/logger";
import { invalidateOidcDiscoveryCache } from "@/lib/sso/oidc-client";
import { isSameOriginRequest } from "@/lib/url";

/**
 * Restore the previously-saved SSO configuration from the snapshot taken on
 * the most recent /api/settings/sso PUT. Single-step undo: gives admins a
 * recovery path when they save broken credentials and need to roll back
 * *without* relying on backup files (which rotate on retention and can end
 * up containing only the broken post-change state).
 *
 * Only useful if the admin can still sign in (Plex/local fallback + the
 * SSO_DISABLE_OVERRIDE env var if SSO is the broken bit). For admins who
 * are fully locked out with no fallback, see the docs for the
 * `scripts/reset-sso.ts` CLI tool or the raw SQL recovery commands.
 *
 * On revert:
 *   - The snapshot replaces the current SSO config fields.
 *   - ssoEnabled is forced to false on the restored config — admin must
 *     explicitly turn it back on in step 3 of the wizard.
 *   - The discovery cache is invalidated.
 *   - The snapshot itself is cleared (single-step undo, no history).
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { previousSsoConfig: true },
  });

  if (!existing || !existing.previousSsoConfig) {
    return NextResponse.json(
      { error: "No previous SSO configuration to revert to." },
      { status: 404 }
    );
  }

  // The snapshot is stored as Json; cast and pull the fields out. Defensive
  // parsing in case the row was hand-edited or came from a backup of an
  // earlier schema.
  const snap = existing.previousSsoConfig as Record<string, unknown>;
  const str = (key: string, fallback: string) =>
    typeof snap[key] === "string" ? (snap[key] as string) : fallback;
  const strOrNull = (key: string) =>
    typeof snap[key] === "string" ? (snap[key] as string) : null;

  // Validate ssoMode is one of the recognized values; tolerate hand-edited
  // garbage in the snapshot by defaulting to OIDC. (Downstream getSsoSettings
  // also normalizes, but writing junk to the DB is worth avoiding.)
  const rawMode = str("ssoMode", "OIDC");
  const ssoMode = rawMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC";

  // The reverted config may use a different issuer URL than the post-change
  // state we're abandoning. If the admin's User row has a linked SSO subject
  // pinned to the *current* (about-to-be-reverted) issuer, that link would
  // be silently broken after revert — login would reject with "not_linked"
  // even though everything looks correct in the UI. Clear the user-level
  // link in the same transaction so the admin has to re-link (Verify & Link)
  // after revert, surfacing the expectation explicitly.
  //
  // sessionVersion bump invalidates any stale sessions that referenced the
  // previous link.
  await prisma.$transaction([
    prisma.appSettings.update({
      where: { userId: session.userId },
      data: {
        // Never auto-re-enable on revert. The admin opts back in via the
        // step 3 toggle once they've verified the restored config works.
        ssoEnabled: false,
        ssoMode,
        oidcIssuer: strOrNull("oidcIssuer"),
        oidcClientId: strOrNull("oidcClientId"),
        oidcClientSecret: strOrNull("oidcClientSecret"),
        oidcScopes: str("oidcScopes", "openid profile email"),
        oidcUsernameClaim: str("oidcUsernameClaim", "preferred_username"),
        forwardAuthUserHeader: str("forwardAuthUserHeader", "Remote-User"),
        forwardAuthEmailHeader: str("forwardAuthEmailHeader", "Remote-Email"),
        forwardAuthNameHeader: str("forwardAuthNameHeader", "Remote-Name"),
        // Json columns use Prisma.JsonNull to explicitly null the value.
        previousSsoConfig: Prisma.JsonNull,
      },
    }),
    prisma.user.update({
      where: { id: session.userId },
      data: {
        ssoSubject: null,
        ssoIssuer: null,
        ssoProvider: null,
        ssoEnabled: false,
        sessionVersion: { increment: 1 },
      },
    }),
  ]);

  // Drop the cache so the next login re-fetches with the reverted issuer.
  invalidateOidcDiscoveryCache();

  // Keep the admin's current session alive after the sessionVersion bump.
  const refreshed = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { sessionVersion: true },
  });
  if (refreshed) {
    session.sessionVersion = refreshed.sessionVersion;
    await session.save();
  }

  apiLogger.info("Auth", "SSO configuration reverted to previous snapshot");

  return NextResponse.json({ ok: true });
}
