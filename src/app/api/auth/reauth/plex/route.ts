import { NextRequest, NextResponse } from "next/server";
import { getPlexUser } from "@/lib/plex/auth";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, plexTokenSchema } from "@/lib/validation";
import { peekAuthRateLimit, reserveAuthAttempt } from "@/lib/rate-limit/rate-limiter";
import { loadReauthContext } from "@/lib/auth/reauth";

/**
 * Confirms the signed-in admin's identity with a Plex OAuth round-trip and
 * stamps `session.authenticatedAt`, so an action that needs a recent sign-in
 * (creating an API key, setting a first password, linking Plex or SSO) can go
 * ahead without signing out and back in. The Plex account must be the one already linked to
 * this user — this never links a new one (that is `/api/auth/plex/link`) —
 * and Plex sign-in must be allowed (`plexLoginEnabled`), as for a Plex login.
 * Like a Plex login, it also refreshes the stored Plex token.
 */
const PLEX_REAUTH_BUCKET = "plex-reauth";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Charged only on a failed confirmation (see `reserveAuthAttempt`); after
  // the session check, so a request that is not signed in never drains it.
  const limited = peekAuthRateLimit(request, PLEX_REAUTH_BUCKET);
  if (limited) return limited;

  const { data, error } = await validateRequest(request, plexTokenSchema);
  if (error) return error;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { plexId: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // No linked Plex account, or Plex sign-in turned off (see reauth.ts).
  if (!user.plexId || !(await loadReauthContext(session.userId)).methods.includes("plex")) {
    return NextResponse.json(
      { error: "Plex sign-in is not available for this account" },
      { status: 400 },
    );
  }

  const attempt = reserveAuthAttempt(request, PLEX_REAUTH_BUCKET);
  if (attempt.refused) return attempt.refused;

  let plexUser;
  try {
    plexUser = await getPlexUser(data.authToken);
  } catch (err) {
    apiLogger.warn("Auth", "Plex re-authentication failed — Plex rejected the token", {
      error: String(err),
    });
    return NextResponse.json({ error: "Plex sign-in failed" }, { status: 401 });
  }

  if (plexUser.id.toString() !== user.plexId) {
    apiLogger.warn("Auth", "Plex re-authentication refused — a different Plex account signed in");
    return NextResponse.json(
      {
        error:
          "Plex signed you in as a different account than the one linked to Librariarr. Sign out of plex.tv, then try again with the linked account.",
      },
      { status: 403 },
    );
  }

  attempt.succeeded();

  await prisma.user.update({
    where: { id: session.userId },
    data: { plexToken: data.authToken },
  });
  session.authenticatedAt = Date.now();
  await session.save();

  apiLogger.info("Auth", "Identity confirmed with Plex");
  return NextResponse.json({ verified: true });
}
