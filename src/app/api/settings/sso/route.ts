import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, ssoConfigSchema } from "@/lib/validation";
import { sanitize } from "@/lib/api/sanitize";
import { isSsoOverrideActive } from "@/lib/sso/config";
import { invalidateOidcDiscoveryCache } from "@/lib/sso/oidc-client";
import { resolveSecretWrite } from "@/lib/sso/secret-write";
import { isSameOriginRequest } from "@/lib/url";

const SSO_SELECT = {
  ssoEnabled: true,
  ssoMode: true,
  oidcIssuer: true,
  oidcClientId: true,
  oidcClientSecret: true,
  oidcScopes: true,
  oidcUsernameClaim: true,
  forwardAuthUserHeader: true,
  forwardAuthEmailHeader: true,
  forwardAuthNameHeader: true,
} as const;

type SsoSettingsRow = {
  ssoEnabled: boolean;
  ssoMode: string;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  oidcScopes: string;
  oidcUsernameClaim: string;
  forwardAuthUserHeader: string;
  forwardAuthEmailHeader: string;
  forwardAuthNameHeader: string;
};

/**
 * Defaults that match the Prisma schema's `@default()` values. Used as the
 * stand-in when the user has no `AppSettings` row yet — Plex-first
 * deployments don't get one until a setting is saved, and we don't want
 * /api/settings/sso to be unusable in that state.
 */
const SSO_DEFAULTS: SsoSettingsRow = {
  ssoEnabled: false,
  ssoMode: "OIDC",
  oidcIssuer: null,
  oidcClientId: null,
  oidcClientSecret: null,
  oidcScopes: "openid profile email",
  oidcUsernameClaim: "preferred_username",
  forwardAuthUserHeader: "Remote-User",
  forwardAuthEmailHeader: "Remote-Email",
  forwardAuthNameHeader: "Remote-Name",
};

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { ...SSO_SELECT, previousSsoConfig: true },
  });

  // If no AppSettings row exists yet (e.g. Plex-first deployment that hasn't
  // saved any setting), return the schema defaults rather than 404. The PUT
  // below upserts, so saving will create the row.
  const effective: SsoSettingsRow = settings ?? SSO_DEFAULTS;

  return NextResponse.json({
    ...sanitize(effective),
    overrideActive: isSsoOverrideActive(),
    // Surface whether a one-step revert is available. UI uses this to gate
    // the "Revert to previous configuration" button in step 1 of the wizard.
    hasPreviousConfig: !!settings?.previousSsoConfig,
  });
}

export async function PUT(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ssoConfigSchema);
  if (error) return error;

  // Load current state so we can validate the requested transition without
  // requiring the client to send the full payload on every PUT. Falls back to
  // schema defaults when no AppSettings exists — the save below upserts.
  const existing = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: SSO_SELECT,
  });
  const current: SsoSettingsRow = existing ?? SSO_DEFAULTS;

  const next = { ...current, ...data };

  // Guard: if enabling SSO, require the selected mode to be fully configured,
  // AND require the current admin user to have an SSO subject linked. Without
  // that, enabling SSO would lock the admin out (since SSO replaces local auth).
  if (next.ssoEnabled) {
    if (next.ssoMode === "OIDC") {
      if (!next.oidcIssuer || !next.oidcClientId) {
        return NextResponse.json(
          { error: "OIDC issuer and client ID are required to enable SSO" },
          { status: 400 }
        );
      }
    } else if (next.ssoMode === "FORWARD_AUTH") {
      if (!next.forwardAuthUserHeader) {
        return NextResponse.json(
          { error: "Forward-auth user header is required to enable SSO" },
          { status: 400 }
        );
      }
    }

    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { ssoSubject: true, ssoEnabled: true },
    });
    if (!me?.ssoSubject || !me.ssoEnabled) {
      return NextResponse.json(
        {
          error:
            "Link an SSO identity to your account (under SSO Account Linking) before enabling SSO. Otherwise you'd lock yourself out.",
        },
        { status: 400 }
      );
    }
  }

  // Lockout guard for the disable path. Disabling SSO restores the local
  // form (subject to localAuthEnabled + passwordHash) and the Plex button
  // (subject to plexLoginEnabled), so verify at least one non-SSO method
  // will be usable afterwards. Without this, an admin who set up SSO-only
  // login (plexLoginEnabled=false, localAuthEnabled=false) could disable
  // SSO and end up with no login methods at all.
  const wasSsoUsable =
    !!current.ssoEnabled && current.ssoMode === "OIDC"
      ? !!current.oidcIssuer && !!current.oidcClientId
      : current.ssoMode === "FORWARD_AUTH"
        ? !!current.forwardAuthUserHeader
        : false;
  const isDisablingSso = wasSsoUsable && next.ssoEnabled === false;
  if (isDisablingSso) {
    const userData = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        plexId: true,
        passwordHash: true,
        appSettings: {
          select: { localAuthEnabled: true, plexLoginEnabled: true },
        },
      },
    });
    const willHavePlex =
      !!userData?.plexId && (userData?.appSettings?.plexLoginEnabled ?? true);
    const willHaveLocal =
      !!userData?.passwordHash && !!userData?.appSettings?.localAuthEnabled;
    if (!willHavePlex && !willHaveLocal) {
      return NextResponse.json(
        {
          error:
            "Cannot disable SSO — you'd have no way to sign in. Enable Plex login " +
            "(Settings → Authentication → Plex Connection) or set up local credentials first.",
        },
        { status: 400 }
      );
    }
  }

  // Normalize empty strings to null so the OIDC client doesn't try to use them
  const writeData = {
    ssoEnabled: next.ssoEnabled,
    ssoMode: next.ssoMode,
    oidcIssuer: next.oidcIssuer?.trim() || null,
    oidcClientId: next.oidcClientId?.trim() || null,
    oidcClientSecret: resolveSecretWrite(data.oidcClientSecret, current.oidcClientSecret),
    oidcScopes: next.oidcScopes,
    oidcUsernameClaim: next.oidcUsernameClaim,
    forwardAuthUserHeader: next.forwardAuthUserHeader,
    forwardAuthEmailHeader: next.forwardAuthEmailHeader,
    forwardAuthNameHeader: next.forwardAuthNameHeader,
  };

  // Snapshot the *current* SSO config into previousSsoConfig — but only if
  // the writable fields actually changed. Without this guard, a no-op save
  // (admin hits Save twice in quick succession, e.g. to clear a UI banner)
  // would overwrite the genuine previous-good config with the new state,
  // destroying the one-step undo.
  //
  // ssoEnabled is excluded from both the comparison and the snapshot
  // contents: revert never auto-re-enables, and the toggle has its own
  // separate code path anyway.
  const changed =
    !existing ||
    current.ssoMode !== writeData.ssoMode ||
    current.oidcIssuer !== writeData.oidcIssuer ||
    current.oidcClientId !== writeData.oidcClientId ||
    current.oidcClientSecret !== writeData.oidcClientSecret ||
    current.oidcScopes !== writeData.oidcScopes ||
    current.oidcUsernameClaim !== writeData.oidcUsernameClaim ||
    current.forwardAuthUserHeader !== writeData.forwardAuthUserHeader ||
    current.forwardAuthEmailHeader !== writeData.forwardAuthEmailHeader ||
    current.forwardAuthNameHeader !== writeData.forwardAuthNameHeader;

  const snapshot: SsoSettingsRow | null =
    existing && changed
      ? {
          ssoEnabled: false, // never auto-re-enable on revert; admin opts in via step 3
          ssoMode: current.ssoMode,
          oidcIssuer: current.oidcIssuer,
          oidcClientId: current.oidcClientId,
          oidcClientSecret: current.oidcClientSecret,
          oidcScopes: current.oidcScopes,
          oidcUsernameClaim: current.oidcUsernameClaim,
          forwardAuthUserHeader: current.forwardAuthUserHeader,
          forwardAuthEmailHeader: current.forwardAuthEmailHeader,
          forwardAuthNameHeader: current.forwardAuthNameHeader,
        }
      : null;

  // Upsert rather than update so a Plex-first deployment whose AppSettings
  // row was never created (now fixed for new installs, but legacy data
  // exists) can save SSO config without first poking some other setting.
  // `previousSsoConfig: undefined` in the update payload means "don't
  // touch this field," preserving any earlier snapshot when this save is
  // a no-op on the writable fields.
  const updated = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { ...writeData, previousSsoConfig: snapshot ?? undefined },
    create: { userId: session.userId, ...writeData },
    select: { ...SSO_SELECT, previousSsoConfig: true },
  });

  // Drop any cached discovery docs so a changed issuer URL (or a rotated
  // signing key, etc.) takes effect on the next login instead of waiting for
  // the TTL to expire.
  invalidateOidcDiscoveryCache();

  // hasPreviousConfig should reflect the *post-save* row state, not just
  // whether this PUT happened to take a snapshot. A no-op save preserves
  // an earlier snapshot via `previousSsoConfig: undefined`, so the row
  // still has one even when `snapshot` here is null.
  return NextResponse.json({
    ...sanitize(updated),
    overrideActive: isSsoOverrideActive(),
    hasPreviousConfig: !!updated.previousSsoConfig,
  });
}
