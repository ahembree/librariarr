import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, ssoLinkSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";
import { currentSsoIssuer, getSsoSettings } from "@/lib/sso/config";
import { isSameOriginRequest } from "@/lib/url";

/**
 * Link an SSO subject identifier to the currently signed-in admin account.
 * The admin enters the value manually (OIDC `sub` claim, or the value that
 * their reverse proxy will inject as the user header).
 *
 * The current canonical issuer (OIDC issuer URL or "forward-auth" sentinel)
 * is captured at link time and stored alongside the subject. Login routes
 * verify both, so switching IdPs doesn't accidentally let a different
 * user's same-named subject sign in as the linked admin.
 *
 * Setting a new subject increments sessionVersion to invalidate other sessions.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ssoLinkSchema);
  if (error) return error;

  const trimmedSubject = data.ssoSubject.trim();
  if (!trimmedSubject) {
    return NextResponse.json({ error: "SSO subject is required" }, { status: 400 });
  }

  // Pin the current SSO mode/issuer at link time so a later issuer change
  // can't silently accept the same subject from a different IdP.
  const settings = await getSsoSettings();
  const issuer = currentSsoIssuer(settings);
  if (!issuer) {
    return NextResponse.json(
      {
        error:
          "Configure SSO mode and issuer (Settings → Authentication → Single Sign-On) before linking an identity.",
      },
      { status: 400 }
    );
  }

  // Reject collision against another user with the SAME subject AND issuer
  // (composite uniqueness is enforced at the DB level too — this is a
  // friendlier error than a P2002).
  const conflict = await prisma.user.findFirst({
    where: {
      ssoSubject: trimmedSubject,
      ssoIssuer: issuer,
      NOT: { id: session.userId },
    },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "This SSO subject is already linked to a different account" },
      { status: 409 }
    );
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: {
      ssoSubject: trimmedSubject,
      ssoIssuer: issuer,
      ssoProvider: data.ssoProvider?.trim() || null,
      ssoEnabled: true,
      sessionVersion: { increment: 1 },
    },
    select: { ssoSubject: true, ssoProvider: true, ssoEnabled: true, sessionVersion: true },
  });

  // Keep the current session alive after bumping sessionVersion
  session.sessionVersion = user.sessionVersion;
  await session.save();

  apiLogger.info("Auth", `SSO linked: ${trimmedSubject}`);

  return NextResponse.json({
    ssoSubject: user.ssoSubject,
    ssoProvider: user.ssoProvider,
    ssoEnabled: user.ssoEnabled,
  });
}

/**
 * Unlink the SSO subject from the current user.
 *
 * Side effects, all in one transaction:
 *   - Clear ssoSubject/ssoProvider and set user.ssoEnabled = false
 *   - If global SSO is currently on, atomically flip AppSettings.ssoEnabled
 *     off as well. The user is effectively saying "I don't use SSO anymore" —
 *     leaving the global toggle on after unlinking would silently lock them
 *     out, since the local username/password form is hidden whenever SSO is
 *     usable. Flipping it off restores the local form on the login page.
 *   - Bump sessionVersion to invalidate other sessions
 *
 * Refuses to unlink only if the user has no other working login method. A
 * working method is either a linked Plex account, OR local credentials
 * (passwordHash set AND localAuthEnabled true). Plex is NOT required —
 * Jellyfin/Emby-only deployments work fine with local credentials as the
 * fallback. (SSO_DISABLE_OVERRIDE is a separate env-var recovery path.)
 */
export async function DELETE(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      plexId: true,
      passwordHash: true,
      appSettings: {
        select: {
          ssoEnabled: true,
          localAuthEnabled: true,
          plexLoginEnabled: true,
        },
      },
    },
  });
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const globalSsoEnabled = me.appSettings?.ssoEnabled ?? false;
  // Plex linkage alone isn't enough — if the admin disabled plexLoginEnabled,
  // the button is hidden and the /api/auth/plex/token route rejects logins.
  // So a "usable Plex fallback" requires both the linkage AND the toggle.
  const hasUsablePlex =
    !!me.plexId && (me.appSettings?.plexLoginEnabled ?? true);
  const hasUsableLocal =
    !!me.passwordHash && !!me.appSettings?.localAuthEnabled;

  if (!hasUsablePlex && !hasUsableLocal) {
    return NextResponse.json(
      {
        error:
          "Cannot unlink SSO without another working login method. " +
          "Either enable Plex login (Settings → Authentication → Plex Connection → Allow Plex Login) " +
          "or set up local credentials first.",
      },
      { status: 400 }
    );
  }

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: session.userId },
      data: {
        ssoSubject: null,
        ssoIssuer: null,
        ssoProvider: null,
        ssoEnabled: false,
        sessionVersion: { increment: 1 },
      },
      select: { sessionVersion: true },
    });
    if (globalSsoEnabled) {
      await tx.appSettings.update({
        where: { userId: session.userId! },
        data: { ssoEnabled: false },
      });
    }
    return u;
  });

  session.sessionVersion = user.sessionVersion;
  await session.save();

  apiLogger.info("Auth", "SSO unlinked");

  return NextResponse.json({
    ssoSubject: null,
    ssoProvider: null,
    ssoEnabled: false,
    // Tells the UI whether unlinking also flipped the global SSO toggle. The
    // settings page uses this to update its in-memory config and surface a
    // notice so the admin isn't surprised when the login screen no longer
    // shows the SSO button.
    globalSsoDisabled: globalSsoEnabled,
  });
}
