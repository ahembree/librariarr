import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, authSettingsSchema } from "@/lib/validation";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";

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
  const ssoUsableNow = isSsoUsable(await getSsoSettings());

  return NextResponse.json({
    plexConnected: !!user.plexId,
    localUsername: user.localUsername,
    hasPassword: !!user.passwordHash,
    localAuthEnabled: user.appSettings?.localAuthEnabled ?? false,
    plexLoginEnabled: user.appSettings?.plexLoginEnabled ?? true,
    localAuthHiddenBySso: ssoUsableNow,
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

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: {
      ...(data.localAuthEnabled !== undefined && { localAuthEnabled: data.localAuthEnabled }),
      ...(data.plexLoginEnabled !== undefined && { plexLoginEnabled: data.plexLoginEnabled }),
    },
    create: {
      userId: session.userId,
      localAuthEnabled: nextLocal,
      plexLoginEnabled: nextPlex,
    },
  });

  return NextResponse.json({
    localAuthEnabled: nextLocal,
    plexLoginEnabled: nextPlex,
  });
}
