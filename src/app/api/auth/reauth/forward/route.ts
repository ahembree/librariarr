import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { currentSsoIssuer } from "@/lib/sso/config";
import { hasForwardAuthSecret, FORWARD_AUTH_PROXY_HEADER } from "@/lib/sso/forward-secret";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { loadReauthContext, ssoIdentityMatches } from "@/lib/auth/reauth";

/**
 * Confirms the signed-in admin's identity from the forward-auth proxy's
 * identity header — the same proof `/api/auth/sso/forward` accepts for a
 * login — and stamps `session.authenticatedAt`. The header must name the
 * subject linked to this user, and `FORWARD_AUTH_SECRET`, when set, must be
 * presented exactly as for a login.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = checkAuthRateLimit(request, "sso-forward-reauth");
  if (rateLimited) return rateLimited;

  // Forward-auth configured and usable, and an identity linked under it.
  const { methods, sso: settings } = await loadReauthContext(session.userId);
  if (!settings || !methods.includes("forward")) {
    return NextResponse.json(
      { error: "SSO sign-in is not available for this account" },
      { status: 400 },
    );
  }

  if (!hasForwardAuthSecret(request.headers)) {
    apiLogger.warn(
      "Auth",
      `Forward-auth re-authentication refused: the ${FORWARD_AUTH_PROXY_HEADER} header is missing or wrong`,
    );
    return NextResponse.json(
      { error: "This request did not come through the configured SSO proxy" },
      { status: 403 },
    );
  }

  const subject = request.headers.get(settings.forwardAuthUserHeader)?.trim() ?? "";
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { ssoEnabled: true, ssoSubject: true, ssoIssuer: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!subject || !ssoIdentityMatches(user, subject, currentSsoIssuer(settings))) {
    apiLogger.warn("Auth", "Forward-auth re-authentication refused — the proxy did not name the linked identity");
    return NextResponse.json(
      { error: "The SSO proxy did not identify you as the linked account" },
      { status: 403 },
    );
  }

  session.authenticatedAt = Date.now();
  await session.save();

  apiLogger.info("Auth", "Identity confirmed with the SSO proxy");
  return NextResponse.json({ verified: true });
}
