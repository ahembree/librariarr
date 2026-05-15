import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getSession } from "@/lib/auth/session";
import { currentSsoIssuer, getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import {
  discoverOidc,
  exchangeCodeForToken,
  fetchUserInfo,
  resolveRedirectUri,
  type OidcUserInfo,
} from "@/lib/sso/oidc-client";
import { sanitizeEmail, sanitizeUsername } from "@/lib/sso/identity-claims";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
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

function redirectToSsoSettings(request: NextRequest, params: Record<string, string>) {
  // Settings page → Authentication tab → SSO section. The hash matches the
  // tab navigation in src/app/(authenticated)/settings/page.tsx.
  const url = new URL("/settings", getExternalBaseUrl(request));
  url.hash = "authentication";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  // Rate-limit the callback too, not just /login init. Each callback hits the
  // IdP for token exchange + userinfo (and discovery if not cached), so an
  // attacker pounding this endpoint with stale code/state values would burn
  // IdP-side resources even though we'd reject every request.
  const rateLimited = checkAuthRateLimit(request, "sso-oidc-callback");
  if (rateLimited) return rateLimited;

  const settings = await getSsoSettings();
  // For login: SSO must be usable (enabled + configured). For link: only the
  // OIDC config needs to be valid -- ssoEnabled can still be false because
  // the admin is mid-setup.
  const session = await getSession();
  const isLinkFlow =
    session.oidcFlow === "link" && session.isLoggedIn && !!session.userId;

  if (!settings || settings.ssoMode !== "OIDC") {
    return isLinkFlow
      ? redirectToSsoSettings(request, { ssoLinkError: "sso_not_configured" })
      : redirectToLogin(request, "sso_not_configured");
  }
  if (!isLinkFlow && !isSsoUsable(settings)) {
    return redirectToLogin(request, "sso_not_configured");
  }
  if (isLinkFlow && (!settings.oidcIssuer || !settings.oidcClientId)) {
    return redirectToSsoSettings(request, { ssoLinkError: "sso_not_configured" });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    apiLogger.warn("Auth", `OIDC provider returned error: ${providerError}`);
    return isLinkFlow
      ? redirectToSsoSettings(request, { ssoLinkError: providerError })
      : redirectToLogin(request, providerError);
  }
  if (!code || !state) {
    return isLinkFlow
      ? redirectToSsoSettings(request, { ssoLinkError: "missing_params" })
      : redirectToLogin(request, "missing_params");
  }

  const expectedState = session.oidcState;
  const verifier = session.oidcVerifier;
  const linkFlowUserId = isLinkFlow ? session.userId! : null;

  // Always wipe the transient handshake fields, even if the exchange fails —
  // they're single-use and shouldn't outlive the redirect they were issued for.
  session.oidcState = undefined;
  session.oidcVerifier = undefined;
  session.oidcFlow = undefined;
  await session.save();

  if (!expectedState || !verifier || !statesEqual(state, expectedState)) {
    apiLogger.warn("Auth", "OIDC state mismatch on callback");
    return isLinkFlow
      ? redirectToSsoSettings(request, { ssoLinkError: "state_mismatch" })
      : redirectToLogin(request, "state_mismatch");
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
    return isLinkFlow
      ? redirectToSsoSettings(request, { ssoLinkError: "token_exchange_failed" })
      : redirectToLogin(request, "token_exchange_failed");
  }

  const subject = userInfo.sub;
  const currentIssuer = currentSsoIssuer(settings)!;

  if (isLinkFlow) {
    // Authenticated admin completing a "verify + capture sub" round-trip.
    // The success of the exchange above proves client_id, client_secret,
    // and redirect URI are all correctly configured. Capture the sub
    // verbatim from the IdP, pin the issuer, mark ssoEnabled on the user.
    // Does NOT enable global SSO -- the admin still does that explicitly
    // in step 3 of the wizard.
    if (!linkFlowUserId) {
      return redirectToSsoSettings(request, { ssoLinkError: "session_lost" });
    }

    // Block linking a sub that's already assigned to a different account
    // (composite key would reject the update anyway; this is a friendlier
    // error). Single-user app so this is mostly defensive.
    const conflict = await prisma.user.findFirst({
      where: {
        ssoSubject: subject,
        ssoIssuer: currentIssuer,
        NOT: { id: linkFlowUserId },
      },
      select: { id: true },
    });
    if (conflict) {
      return redirectToSsoSettings(request, { ssoLinkError: "conflict" });
    }

    let updated;
    try {
      updated = await prisma.user.update({
        where: { id: linkFlowUserId },
        data: {
          ssoSubject: subject,
          ssoIssuer: currentIssuer,
          ssoEnabled: true,
          // Sync the IdP-provided display name + email if non-empty.
          ...syncableFields(userInfo, settings.oidcUsernameClaim),
          // Linking is a credential change → invalidate other sessions.
          sessionVersion: { increment: 1 },
        },
        select: { sessionVersion: true, username: true },
      });
    } catch (err) {
      // Two realistic Prisma error codes to distinguish:
      //   P2025 — user row was deleted between flow start and callback
      //     (e.g. via scripts/reset-auth.js delete-user while the admin
      //     was at the IdP). Maps to session_lost.
      //   P2002 — the composite (ssoSubject, ssoIssuer) unique index was
      //     hit by a concurrent link from another window/tab racing this
      //     one. The defensive findFirst above narrows the window but
      //     can't close it. Maps to conflict so the admin sees the same
      //     message they would on a pre-check hit.
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2002") {
          apiLogger.warn("Auth", "OIDC link hit composite unique violation");
          return redirectToSsoSettings(request, { ssoLinkError: "conflict" });
        }
        if (err.code === "P2025") {
          apiLogger.warn("Auth", "OIDC link failed: user row missing", {
            userId: linkFlowUserId,
          });
          return redirectToSsoSettings(request, { ssoLinkError: "session_lost" });
        }
      }
      apiLogger.error("Auth", "OIDC link update failed", {
        error: String(err),
      });
      return redirectToSsoSettings(request, { ssoLinkError: "session_lost" });
    }

    // Keep the current admin's session alive after the version bump.
    session.sessionVersion = updated.sessionVersion;
    await session.save();

    apiLogger.info(
      "Auth",
      `SSO (OIDC) linked via flow: "${updated.username}" sub=${subject}`
    );

    return redirectToSsoSettings(request, { ssoLinked: "1" });
  }

  // ── Login flow (anonymous user authenticating) ────────────────────────

  // Match on (ssoSubject, ssoIssuer) composite — but also accept legacy rows
  // with ssoIssuer=null (linked before the column existed) and backfill
  // below. Including the issuer in the WHERE rather than fetching first and
  // verifying afterwards means a legitimate cross-issuer same-subject row
  // can't be silently returned and rejected.
  const user = await prisma.user.findFirst({
    where: {
      ssoSubject: subject,
      OR: [{ ssoIssuer: currentIssuer }, { ssoIssuer: null }],
    },
  });

  if (!user || !user.ssoEnabled) {
    apiLogger.warn(
      "Auth",
      `OIDC login rejected: no linked account for sub=${subject}`
    );
    return redirectToLogin(request, "not_linked");
  }

  // Legacy rows (linked before the ssoIssuer column existed) come back with
  // ssoIssuer=null thanks to the OR clause above. Backfill the current
  // issuer so subsequent logins use strict matching.
  if (user.ssoIssuer === null) {
    await prisma.user.update({
      where: { id: user.id },
      data: { ssoIssuer: currentIssuer },
    });
  }

  // Sync configured claims into the User record.
  const sync = syncableFields(userInfo, settings.oidcUsernameClaim);
  const updateData: { username?: string; email?: string } = {};
  if (sync.username && sync.username !== user.username) {
    updateData.username = sync.username;
  }
  if (sync.email && sync.email !== user.email) {
    updateData.email = sync.email;
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

  return NextResponse.redirect(new URL("/", getExternalBaseUrl(request)));
}

/** Extract username + email from a userinfo payload via the shared
 *  identity-claim sanitizer: rejects non-strings, control chars, oversize
 *  values, and obviously-bogus emails. Returns undefined for unusable
 *  values so the caller leaves the field alone. */
function syncableFields(
  info: OidcUserInfo,
  usernameClaim: string,
): { username?: string; email?: string } {
  const result: { username?: string; email?: string } = {};
  const username = sanitizeUsername(info[usernameClaim]);
  if (username) result.username = username;
  const email = sanitizeEmail(info.email);
  if (email) result.email = email;
  return result;
}
