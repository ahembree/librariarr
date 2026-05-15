import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiLogger } from "@/lib/logger";
import { invalidateOidcDiscoveryCache } from "@/lib/sso/oidc-client";

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
export async function POST() {
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

  await prisma.appSettings.update({
    where: { userId: session.userId },
    data: {
      // Never auto-re-enable on revert. The admin opts back in via the
      // step 3 toggle once they've verified the restored config works.
      ssoEnabled: false,
      ssoMode: str("ssoMode", "OIDC"),
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
  });

  // The reverted config may use a different issuer URL than the post-change
  // state we're abandoning. Drop the cache so the next login re-fetches.
  invalidateOidcDiscoveryCache();

  apiLogger.info("Auth", "SSO configuration reverted to previous snapshot");

  return NextResponse.json({ ok: true });
}
