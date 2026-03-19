import { NextRequest, NextResponse } from "next/server";
import { getPlexUser } from "@/lib/plex/auth";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, plexTokenSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "plex-token");
    if (rateLimited) return rateLimited;

    const { data, error } = await validateRequest(request, plexTokenSchema);
    if (error) return error;

    const { authToken } = data;
    const plexUser = await getPlexUser(authToken);
    const plexIdStr = plexUser.id.toString();

    // Check if a user with this Plex ID already exists
    const existingUser = await prisma.user.findUnique({
      where: { plexId: plexIdStr },
    });

    if (existingUser) {
      // Existing Plex user — update token and log in
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          plexToken: authToken,
          email: plexUser.email,
          username: plexUser.username,
        },
      });

      const session = await getSession();
      session.userId = existingUser.id;
      session.plexToken = authToken;
      session.isLoggedIn = true;
      session.sessionVersion = existingUser.sessionVersion;
      await session.save();

      return NextResponse.json({
        authenticated: true,
        user: { id: existingUser.id, username: plexUser.username },
      });
    }

    // No user with this Plex ID — check if any users exist (single-admin app)
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return NextResponse.json(
        { error: "This Plex account is not linked to the admin user. Use Settings > Authentication to link your Plex account." },
        { status: 403 }
      );
    }

    // No users exist at all — create the first user via Plex
    const user = await prisma.user.create({
      data: {
        plexId: plexIdStr,
        plexToken: authToken,
        email: plexUser.email,
        username: plexUser.username,
      },
    });

    const session = await getSession();
    session.userId = user.id;
    session.plexToken = authToken;
    session.isLoggedIn = true;
    session.sessionVersion = 0;
    await session.save();

    return NextResponse.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "Plex token auth failed", { error: String(error) });
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}
