import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, ssoLinkSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";

/**
 * Link an SSO subject identifier to the currently signed-in admin account.
 * The admin enters the value manually (OIDC `sub` claim, or the value that
 * their reverse proxy will inject as the user header).
 *
 * Setting a new subject increments sessionVersion to invalidate other sessions.
 */
export async function POST(request: NextRequest) {
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

  // Reject collision with another user (in case a future release adds multi-user support)
  const conflict = await prisma.user.findFirst({
    where: { ssoSubject: trimmedSubject, NOT: { id: session.userId } },
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

/** Unlink the SSO subject from the current user. Bumps sessionVersion. */
export async function DELETE() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Don't allow unlinking if the user has no other way to log in
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { plexId: true, passwordHash: true, appSettings: { select: { ssoEnabled: true } } },
  });
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (me.appSettings?.ssoEnabled && !me.plexId && !me.passwordHash) {
    return NextResponse.json(
      { error: "Cannot unlink SSO while SSO is the only enabled login method" },
      { status: 400 }
    );
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: {
      ssoSubject: null,
      ssoProvider: null,
      ssoEnabled: false,
      sessionVersion: { increment: 1 },
    },
    select: { sessionVersion: true },
  });

  session.sessionVersion = user.sessionVersion;
  await session.save();

  apiLogger.info("Auth", "SSO unlinked");

  return NextResponse.json({ ssoSubject: null, ssoProvider: null, ssoEnabled: false });
}
