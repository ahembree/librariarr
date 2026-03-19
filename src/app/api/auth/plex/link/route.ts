import { NextRequest, NextResponse } from "next/server";
import { checkPlexPin, getPlexUser } from "@/lib/plex/auth";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, plexLinkSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify user still exists (handles stale sessions after DB reset)
  const currentUser = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, sessionVersion: true },
  });
  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await validateRequest(request, plexLinkSchema);
    if (error) return error;

    // Resolve the Plex auth token from either direct authToken or pinId
    let plexAuthToken: string;
    if (data.authToken) {
      plexAuthToken = data.authToken;
    } else if (data.pinId) {
      const pin = await checkPlexPin(data.pinId);
      if (!pin.authToken) {
        return NextResponse.json({ linked: false, message: "Plex authentication not yet completed" });
      }
      plexAuthToken = pin.authToken;
    } else {
      return NextResponse.json({ error: "Validation failed" }, { status: 400 });
    }

    const plexUser = await getPlexUser(plexAuthToken);
    const plexIdStr = plexUser.id.toString();

    // Check if another user already has this Plex ID
    const existingPlexUser = await prisma.user.findUnique({
      where: { plexId: plexIdStr },
    });

    if (existingPlexUser && existingPlexUser.id !== session.userId) {
      return NextResponse.json(
        { error: "This Plex account is already linked to another user" },
        { status: 409 }
      );
    }

    // Link Plex to the current user
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        plexId: plexIdStr,
        plexToken: plexAuthToken,
        email: plexUser.email || undefined,
      },
    });

    // Update session with plexToken and current version
    session.plexToken = plexAuthToken;
    session.sessionVersion = currentUser.sessionVersion;
    await session.save();

    apiLogger.info("Auth", `Plex account linked for user "${session.userId}"`);

    return NextResponse.json({
      linked: true,
      plexUsername: plexUser.username,
    });
  } catch (error) {
    apiLogger.error("Auth", "Plex link failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to link Plex account" },
      { status: 500 }
    );
  }
}
