import { NextRequest, NextResponse } from "next/server";
import { getPlexUser } from "@/lib/plex/auth";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, plexTokenSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { isSsoOverrideActive } from "@/lib/sso/config";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "plex-token");
    if (rateLimited) return rateLimited;

    const { data, error } = await validateRequest(request, plexTokenSchema);
    if (error) return error;

    const { authToken } = data;
    const plexUser = await getPlexUser(authToken);
    const plexIdStr = plexUser.id.toString();

    // Reject the login flow when the admin has disabled Plex login (but only
    // after setup is complete — first-user creation via Plex always works).
    // The /api/auth/plex/link endpoint used by Settings → Connect Plex Account
    // is unaffected by this check, so admins can still link/relink Plex while
    // keeping the login button hidden on the public login page.
    const initialCount = await prisma.user.count();
    if (initialCount > 0) {
      const settings = await prisma.appSettings.findFirst({
        select: { plexLoginEnabled: true },
      });
      // SSO_DISABLE_OVERRIDE bypasses this gate — the override is a recovery
      // mode and the login page surfaces the Plex button under it, so the
      // server must accept the login or the UI would be misleading.
      if (
        settings &&
        settings.plexLoginEnabled === false &&
        !isSsoOverrideActive()
      ) {
        return NextResponse.json(
          { error: "Plex login is disabled by the administrator." },
          { status: 403 }
        );
      }
    }

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

      // Destroy first to clear any transient state (e.g. SSO handshake fields
      // from an abandoned OIDC init) before replacing with the authenticated
      // session — matches the pattern in local/login and the SSO callback.
      const session = await getSession();
      session.destroy();
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

    // No user with this Plex ID — single-admin app, so reject if any user
    // already exists. (Initial check above bounced the post-setup case; this
    // path is for the initial-setup flow.)
    if (initialCount > 0) {
      return NextResponse.json(
        { error: "This Plex account is not linked to the admin user. Use Settings > Authentication to link your Plex account." },
        { status: 403 }
      );
    }

    // First-user creation. Serializable transaction so two concurrent setup
    // requests can't both pass the userCount check and both create admins
    // (which would silently produce two users with different plexIds, since
    // the unique constraint is on plexId, not on "being the singleton admin").
    // PostgreSQL SSI will commit one and fail the other with a serialization
    // error — the loser sees a 500 and can retry.
    const user = await prisma.$transaction(
      async (tx) => {
        const inner = await tx.user.count();
        if (inner > 0) return null;
        return await tx.user.create({
          data: {
            plexId: plexIdStr,
            plexToken: authToken,
            email: plexUser.email,
            username: plexUser.username,
          },
        });
      },
      { isolationLevel: "Serializable" }
    );

    if (!user) {
      // Another request beat us during setup — surface the same error the
      // post-setup path would.
      return NextResponse.json(
        { error: "This Plex account is not linked to the admin user. Use Settings > Authentication to link your Plex account." },
        { status: 403 }
      );
    }

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
