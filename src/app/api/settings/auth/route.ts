import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, authSettingsSchema } from "@/lib/validation";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import {
  lockSignInSettings,
  passwordSignInEnabled,
  turnsPasswordSignInOn,
  turnsPlexSignInOn,
} from "@/lib/auth/password-sign-in";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      plexId: true,
      localUsername: true,
      passwordHash: true,
      username: true,
      appSettings: {
        select: { localAuthEnabled: true, plexLoginEnabled: true },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Report whether SSO is currently the effective gate on the local form.
  // When true, the login page hides the local username/password form even if
  // localAuthEnabled is true in the DB — so the Authentication tab should
  // surface that to avoid the confusion of "Local Login is ON but the form
  // doesn't appear on the login page".
  const sso = await getSsoSettings();
  const ssoUsableNow = isSsoUsable(sso);

  return NextResponse.json({
    plexConnected: !!user.plexId,
    localUsername: user.localUsername,
    hasPassword: !!user.passwordHash,
    localAuthEnabled: user.appSettings?.localAuthEnabled ?? false,
    plexLoginEnabled: user.appSettings?.plexLoginEnabled ?? true,
    localAuthHiddenBySso: ssoUsableNow,
    // Whether the password is accepted at all (password-sign-in.ts). The
    // settings page asks for the current password only while it is.
    passwordSignInEnabled: passwordSignInEnabled({
      localAuthEnabled: user.appSettings?.localAuthEnabled,
      sso,
    }),
    displayName: user.username,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, authSettingsSchema);
  if (error) return error;

  // Load everything we need to evaluate the lockout guard. We check the
  // post-update state, not just the toggle being flipped, so partial updates
  // (only one field changed) are evaluated correctly against current values.
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      plexId: true,
      passwordHash: true,
      ssoSubject: true,
      ssoEnabled: true,
      appSettings: {
        select: { localAuthEnabled: true, plexLoginEnabled: true },
      },
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ssoSettings = await getSsoSettings();
  const ssoUsable = isSsoUsable(ssoSettings);

  const nextLocal = data.localAuthEnabled ?? user.appSettings?.localAuthEnabled ?? false;
  const nextPlex = data.plexLoginEnabled ?? user.appSettings?.plexLoginEnabled ?? true;

  // Don't let admins enable local auth without a password set — the form
  // would appear on the login page but every submission would fail. Client
  // already runs a credential-prompt dialog, but a direct API call would
  // bypass that.
  if (nextLocal && !user.passwordHash) {
    return NextResponse.json(
      {
        error:
          "Set a local password first (Settings → Authentication → Local Authentication) " +
          "before enabling local login.",
      },
      { status: 400 }
    );
  }

  // What login methods would the user have after this update? At least one
  // must remain. Note: when SSO is usable, the local form is hidden on the
  // login page, so a passwordHash + localAuthEnabled combo doesn't help
  // until SSO is disabled.
  const willHavePlex = nextPlex && !!user.plexId;
  const willHaveLocal = nextLocal && !!user.passwordHash && !ssoUsable;
  const willHaveSso = ssoUsable && !!user.ssoSubject && user.ssoEnabled;

  if (!willHavePlex && !willHaveLocal && !willHaveSso) {
    return NextResponse.json(
      {
        error:
          "Cannot disable this login method — you'd have no way to sign in. " +
          "Enable at least one of: Plex login (with a linked Plex account), " +
          "local credentials, or SSO (with a linked identity).",
      },
      { status: 400 }
    );
  }

  // Turning local login on gives an existing password its power back, and
  // while it was off the password counted for nothing — so a stolen cookie
  // that knows an old password must not be able to switch it on and then use
  // it. Turning Plex login on is the same for whoever holds a Plex account the
  // household shares. Either needs a recent sign-in, by another method
  // (password-sign-in.ts). Checked and written under the sign-in settings
  // lock, against the state as it is then: checked against the snapshot
  // above, a concurrent change (SSO turned off) could pass on this one's old
  // state while this one passed on its.
  const userId = session.userId;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockSignInSettings(tx);
    const current = await tx.appSettings.findUnique({
      where: { userId },
      select: { localAuthEnabled: true, plexLoginEnabled: true },
    });
    const sso = await getSsoSettings(tx);
    const local = data.localAuthEnabled ?? current?.localAuthEnabled ?? false;
    const plex = data.plexLoginEnabled ?? current?.plexLoginEnabled ?? true;
    if (!hasRecentLogin(session)) {
      if (
        turnsPasswordSignInOn(
          { localAuthEnabled: current?.localAuthEnabled, sso },
          { localAuthEnabled: local, sso },
          !!user.passwordHash,
        )
      ) {
        return { refused: "Turning on local login" } as const;
      }
      if (turnsPlexSignInOn(current?.plexLoginEnabled, plex, !!user.plexId)) {
        return { refused: "Turning on Plex login" } as const;
      }
    }
    await tx.appSettings.upsert({
      where: { userId },
      update: {
        ...(data.localAuthEnabled !== undefined && { localAuthEnabled: data.localAuthEnabled }),
        ...(data.plexLoginEnabled !== undefined && { plexLoginEnabled: data.plexLoginEnabled }),
      },
      create: { userId, localAuthEnabled: local, plexLoginEnabled: plex },
    });
    return { refused: null, local, plex } as const;
  });
  if (outcome.refused) return reauthRequired(userId, outcome.refused);

  return NextResponse.json({
    localAuthEnabled: outcome.local,
    plexLoginEnabled: outcome.plex,
  });
}
