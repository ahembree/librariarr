import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Returns the current admin's display identity for UI chrome (sidebar/topbar
 * user chip): display name and a best-effort primary auth method label.
 * Exposes no secrets — username and method are safe to render.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      username: true,
      email: true,
      plexId: true,
      ssoEnabled: true,
      ssoProvider: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Primary method label, mirroring how the login surfaces are gated.
  const authMethod =
    user.ssoEnabled && user.ssoProvider
      ? user.ssoProvider
      : user.plexId
        ? "Plex"
        : "Local";

  return NextResponse.json({
    username: user.username,
    email: user.email,
    authMethod,
  });
}
