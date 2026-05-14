import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { getExternalBaseUrl, isSameOriginRequest } from "@/lib/url";

/**
 * Forward-auth login: trusts identity headers injected by an upstream reverse
 * proxy (Authelia, Authentik, oauth2-proxy, etc.). The proxy must be the only
 * way to reach this app — if users can hit it directly they could spoof these
 * headers. The admin is responsible for that network topology.
 *
 * GET so it can be linked from the login page as a normal anchor.
 */
export async function GET(request: NextRequest) {
  const baseUrl = getExternalBaseUrl(request);

  // Block cross-site CSRF where a malicious page force-triggers this route.
  // Strict mode rejects requests with neither Origin nor Referer (only
  // reachable here via an attacker page setting `Referrer-Policy:
  // no-referrer`). The route is only ever invoked from the "Sign in with
  // SSO" anchor on /login, which always carries a same-origin Referer —
  // no legitimate flow lands here without one.
  if (!isSameOriginRequest(request, { strict: true })) {
    return NextResponse.redirect(new URL("/login?sso_error=csrf_blocked", baseUrl));
  }

  const rateLimited = checkAuthRateLimit(request, "sso-forward");
  if (rateLimited) return rateLimited;

  const settings = await getSsoSettings();
  if (!isSsoUsable(settings) || settings?.ssoMode !== "FORWARD_AUTH") {
    return NextResponse.redirect(new URL("/login?sso_error=sso_not_configured", baseUrl));
  }

  const subject = request.headers.get(settings.forwardAuthUserHeader);
  if (!subject) {
    apiLogger.warn(
      "Auth",
      `Forward-auth login rejected: missing ${settings.forwardAuthUserHeader} header`
    );
    return NextResponse.redirect(new URL("/login?sso_error=missing_user_header", baseUrl));
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
    return NextResponse.redirect(new URL("/login?sso_error=not_linked", baseUrl));
  }

  // Optional identity claims from the proxy. Sync into the User record so
  // the display name + email track the IdP. (Previously these were stored
  // as configurable header names but never read — dead config.)
  const emailHeader = request.headers.get(settings.forwardAuthEmailHeader);
  const nameHeader = request.headers.get(settings.forwardAuthNameHeader);
  const updateData: { email?: string; username?: string } = {};
  if (emailHeader && emailHeader.trim() && emailHeader !== user.email) {
    updateData.email = emailHeader.trim();
  }
  if (nameHeader && nameHeader.trim() && nameHeader !== user.username) {
    updateData.username = nameHeader.trim();
  }
  if (Object.keys(updateData).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: updateData });
  }

  const session = await getSession();
  session.destroy();
  session.userId = user.id;
  session.isLoggedIn = true;
  session.sessionVersion = user.sessionVersion;
  if (user.plexToken) session.plexToken = user.plexToken;
  await session.save();

  apiLogger.info("Auth", `SSO (forward-auth) login: "${user.username}"`);

  return NextResponse.redirect(new URL("/", baseUrl));
}
