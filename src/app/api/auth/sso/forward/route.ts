import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

/**
 * Forward-auth login: trusts identity headers injected by an upstream reverse
 * proxy (Authelia, Authentik, oauth2-proxy, etc.). The proxy must be the only
 * way to reach this app — if users can hit it directly they could spoof these
 * headers. The admin is responsible for that network topology.
 *
 * GET so it can be linked from the login page as a normal anchor.
 */
export async function GET(request: NextRequest) {
  const rateLimited = checkAuthRateLimit(request, "sso-forward");
  if (rateLimited) return rateLimited;

  const settings = await getSsoSettings();
  if (!isSsoUsable(settings) || settings?.ssoMode !== "FORWARD_AUTH") {
    return NextResponse.redirect(new URL("/login?sso_error=sso_not_configured", request.url));
  }

  const subject = request.headers.get(settings.forwardAuthUserHeader);
  if (!subject) {
    apiLogger.warn(
      "Auth",
      `Forward-auth login rejected: missing ${settings.forwardAuthUserHeader} header`
    );
    return NextResponse.redirect(new URL("/login?sso_error=missing_user_header", request.url));
  }

  // Manual-linking policy: subject must match an existing user with ssoEnabled.
  const user = await prisma.user.findUnique({
    where: { ssoSubject: subject },
  });
  if (!user || !user.ssoEnabled) {
    apiLogger.warn(
      "Auth",
      `Forward-auth login rejected: no linked account for "${subject}"`
    );
    return NextResponse.redirect(new URL("/login?sso_error=not_linked", request.url));
  }

  const session = await getSession();
  session.destroy();
  session.userId = user.id;
  session.isLoggedIn = true;
  session.sessionVersion = user.sessionVersion;
  if (user.plexToken) session.plexToken = user.plexToken;
  await session.save();

  apiLogger.info("Auth", `SSO (forward-auth) login: "${user.username}"`);

  return NextResponse.redirect(new URL("/", request.url));
}
