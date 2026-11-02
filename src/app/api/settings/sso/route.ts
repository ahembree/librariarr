import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, ssoConfigSchema } from "@/lib/validation";
import { sanitize } from "@/lib/api/sanitize";
import { currentSsoIssuer, isSsoOverrideActive, ssoUnusableReason } from "@/lib/sso/config";
import { isForwardAuthSecretConfigured } from "@/lib/sso/forward-secret";
import { invalidateOidcDiscoveryCache } from "@/lib/sso/oidc-client";
import { resolveSecretWrite } from "@/lib/sso/secret-write";
import { isSameOriginRequest } from "@/lib/url";
import {
  loadPasswordSignInState,
  lockSignInSettings,
  turnsPasswordSignInOn,
} from "@/lib/auth/password-sign-in";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired, ssoLinkedToIssuer } from "@/lib/auth/reauth";
import { stripTrailingSlashes } from "@/lib/url-normalize";

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

export const GET = withSession(async (session) => {
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
    // Forward-auth cannot be turned on without it (see forward-secret.ts); the
    // UI says so beside the mode rather than at the toggle.
    forwardAuthSecretConfigured: isForwardAuthSecretConfigured(),
  });
});

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
      // Trimmed as they will be stored: whitespace alone saves as null.
      if (!next.oidcIssuer?.trim() || !next.oidcClientId?.trim()) {
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
    // Everything the login would refuse (FORWARD_AUTH_SECRET unset, an http://
    // issuer stored under the older rule): turning SSO on against it would
    // leave a button on the login page that cannot be honoured. Only when the
    // save turns SSO on — on an install where it was on before the
    // requirement, header names and the rest must stay saveable while the
    // admin sorts the environment out.
    const turningOn = data.ssoEnabled === true || !current.ssoEnabled;
    const unusable = turningOn
      ? ssoUnusableReason({
          ...next,
          ssoMode: next.ssoMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC",
          oidcIssuer: next.oidcIssuer?.trim() || null,
          oidcClientId: next.oidcClientId?.trim() || null,
        })
      : null;
    if (unusable) {
      return NextResponse.json({ error: `SSO cannot be turned on: ${unusable}` }, { status: 400 });
    }

    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { ssoSubject: true, ssoEnabled: true, ssoIssuer: true },
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
    // And linked under the issuer these settings would use. Another issuer,
    // or the other mode, while SSO stays on would orphan the link: SSO login
    // refuses it as not_linked, the password is off because SSO replaces it,
    // and nothing is left to confirm "it's you" with to turn SSO off again.
    const nextIssuer = currentSsoIssuer({
      ...next,
      ssoMode: next.ssoMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC",
      oidcIssuer: next.oidcIssuer?.trim() || null,
    });
    if (!ssoLinkedToIssuer(me, nextIssuer)) {
      return NextResponse.json(
        {
          error:
            "Your SSO identity is linked under a different issuer or mode. Turn SSO login off first, then save these settings, link your identity again and turn SSO login back on. Otherwise you'd lock yourself out.",
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
  //
  // Turning SSO off hands the login page back to the local form, and with it
  // gives an existing password its power back — while SSO was on the password
  // counted for nothing, so a stolen cookie that knows an old password must
  // not be able to switch SSO off and then use it (password-sign-in.ts).
  // Checked and written under the sign-in settings lock, against the state as
  // it is then, so a concurrent change (local login turned on) cannot pass on
  // this one's old state while this one passes on its.
  const userId = session.userId;

  // Which identity SSO accepts is decided by the mode and, for forward-auth,
  // by the header the proxy is trusted to set. A proxy overwrites its own
  // identity headers but usually passes others through from the client, so a
  // stolen cookie that could name another header would let anyone the proxy
  // admits send the admin's subject in it — signing in, or renewing a stale
  // session through reauth/forward. Changing either needs a recent sign-in,
  // and so does turning SSO on, or a change made while it was off would take
  // effect without one.
  //
  // In OIDC mode the issuer is that source: it is who vouches for the subject,
  // and the stored client secret goes to its token endpoint. A link made before
  // issuers were recorded (`ssoIssuer` null) is accepted under any issuer, so a
  // stale cookie could point SSO at its own IdP, answer an OIDC confirmation
  // with the admin's subject and come back with a fresh sign-in. While SSO is
  // off nothing reads the issuer — no login, no confirmation, and linking or
  // turning SSO on asks for a recent sign-in itself — so setup is not prompted.
  const issuerOf = (issuer: string | null) => stripTrailingSlashes(issuer ?? "");
  const changesIdentitySource =
    writeData.ssoMode !== current.ssoMode ||
    writeData.forwardAuthUserHeader !== current.forwardAuthUserHeader ||
    (current.ssoEnabled &&
      writeData.ssoMode === "OIDC" &&
      issuerOf(writeData.oidcIssuer) !== issuerOf(current.oidcIssuer));
  const turnsSsoOn = !!writeData.ssoEnabled && !current.ssoEnabled;
  if ((changesIdentitySource || turnsSsoOn) && !hasRecentLogin(session)) {
    return reauthRequired(userId, turnsSsoOn ? "Turning on SSO" : "Changing which identity SSO trusts");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await lockSignInSettings(tx);
    const before = await loadPasswordSignInState(tx);
    const me = await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (
      turnsPasswordSignInOn(
        before,
        {
          localAuthEnabled: before.localAuthEnabled,
          sso: { ...writeData, ssoMode: writeData.ssoMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC" },
        },
        !!me?.passwordHash,
      ) &&
      !hasRecentLogin(session)
    ) {
      return null;
    }
    return tx.appSettings.upsert({
      where: { userId },
      update: { ...writeData, previousSsoConfig: snapshot ?? undefined },
      create: { userId, ...writeData },
      select: { ...SSO_SELECT, previousSsoConfig: true },
    });
  });
  if (!updated) return reauthRequired(userId, "Turning off SSO");

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
