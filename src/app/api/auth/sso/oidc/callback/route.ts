import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { currentSsoIssuer, getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import {
  discoverOidc,
  exchangeCodeForToken,
  fetchUserInfo,
  resolveRedirectUri,
  type OidcUserInfo,
} from "@/lib/sso/oidc-client";
import { apiLogger } from "@/lib/logger";
import { getExternalBaseUrl } from "@/lib/url";

/** Constant-time comparison for the OIDC state value. Lengths differ → false. */
function statesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function redirectToLogin(request: NextRequest, error: string) {
  const url = new URL("/login", getExternalBaseUrl(request));
  url.searchParams.set("sso_error", error);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const settings = await getSsoSettings();
  if (!isSsoUsable(settings) || settings?.ssoMode !== "OIDC") {
    return redirectToLogin(request, "sso_not_configured");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    apiLogger.warn("Auth", `OIDC provider returned error: ${providerError}`);
    return redirectToLogin(request, providerError);
  }
  if (!code || !state) {
    return redirectToLogin(request, "missing_params");
  }

  const session = await getSession();
  const expectedState = session.oidcState;
  const verifier = session.oidcVerifier;

  // Always wipe the transient handshake fields, even if the exchange fails —
  // they're single-use and shouldn't outlive the redirect they were issued for.
  session.oidcState = undefined;
  session.oidcVerifier = undefined;
  await session.save();

  if (!expectedState || !verifier || !statesEqual(state, expectedState)) {
    apiLogger.warn("Auth", "OIDC state mismatch on callback");
    return redirectToLogin(request, "state_mismatch");
  }

  let userInfo: OidcUserInfo;
  try {
    const discovery = await discoverOidc(settings.oidcIssuer!);
    const tokens = await exchangeCodeForToken({
      discovery,
      clientId: settings.oidcClientId!,
      clientSecret: settings.oidcClientSecret,
      code,
      redirectUri: resolveRedirectUri(request),
      codeVerifier: verifier,
    });
    userInfo = await fetchUserInfo(discovery, tokens.access_token);
  } catch (error) {
    apiLogger.error("Auth", "OIDC code exchange failed", {
      error: String(error),
    });
    return redirectToLogin(request, "token_exchange_failed");
  }

  // Manual-linking policy: a user record with this (sub, issuer) pair must
  // already exist and have ssoEnabled = true. Auto-provisioning disabled.
  const subject = userInfo.sub;
  const currentIssuer = currentSsoIssuer(settings)!; // non-null: isSsoUsable verified above

  // Look up by sub first. We then verify the issuer separately so we can
  // backfill legacy rows (linked before the ssoIssuer column existed) with
  // the current issuer on first login -- otherwise post-upgrade the admin
  // would lose SSO until they manually re-linked.
  const user = await prisma.user.findFirst({
    where: { ssoSubject: subject },
  });

  if (!user || !user.ssoEnabled) {
    apiLogger.warn(
      "Auth",
      `OIDC login rejected: no linked account for sub=${subject}`
    );
    return redirectToLogin(request, "not_linked");
  }

  if (user.ssoIssuer === null) {
    // Legacy row: link predates the ssoIssuer column. Trust the current
    // configured issuer and pin it. After this, strict matching applies.
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoIssuer: currentIssuer },
    });
  } else if (user.ssoIssuer !== currentIssuer) {
    // Issuer changed since link time -- could be admin reconfiguration or
    // a cross-IdP collision attack. Either way, refuse the login until the
    // admin explicitly re-links from the new issuer.
    apiLogger.warn(
      "Auth",
      `OIDC login rejected: issuer mismatch (linked=${user.ssoIssuer}, current=${currentIssuer}) for sub=${subject}`
    );
    return redirectToLogin(request, "not_linked");
  }

  // Sync configured claims into the User record so display fields track the
  // IdP. Username and email update independently so an email-only change
  // (with stable username) still propagates. Trim before save to avoid
  // persistent whitespace and the redundant-write loop it causes.
  const usernameClaim = userInfo[settings.oidcUsernameClaim];
  const newUsername =
    typeof usernameClaim === "string" ? usernameClaim.trim() : "";
  const newEmail =
    typeof userInfo.email === "string" ? userInfo.email.trim() : "";

  const updateData: { username?: string; email?: string } = {};
  if (newUsername && newUsername !== user.username) {
    updateData.username = newUsername;
  }
  if (newEmail && newEmail !== user.email) {
    updateData.email = newEmail;
  }
  if (Object.keys(updateData).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: updateData });
  }

  // Replace any prior session data so we don't leak Plex tokens across logins.
  session.destroy();
  session.userId = user.id;
  session.isLoggedIn = true;
  session.sessionVersion = user.sessionVersion;
  if (user.plexToken) session.plexToken = user.plexToken;
  await session.save();

  apiLogger.info("Auth", `SSO (OIDC) login: "${user.username}"`);

  // Use the externally-visible base URL, not the raw request URL. Behind a
  // reverse proxy, `request.url` is the internal hostname (e.g.
  // http://librariarr:3000) and redirecting there would land users on a
  // broken page. resolveRedirectUri builds the IdP callback URL the same way
  // — keep them consistent.
  return NextResponse.redirect(new URL("/", getExternalBaseUrl(request)));
}
