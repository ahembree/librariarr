import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  buildAuthorizationUrl,
  discoverOidc,
  generatePkce,
  generateState,
  resolveRedirectUri,
} from "@/lib/sso/oidc-client";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { loadReauthContext } from "@/lib/auth/reauth";

/**
 * Starts an OIDC round-trip that confirms the signed-in admin's identity
 * rather than logging in. `prompt=login` asks the IdP to authenticate again
 * instead of answering from its own session. The callback
 * (`/api/auth/sso/oidc/callback`) reads `session.oidcFlow === "reauth"`,
 * checks the subject is the one linked to this user, stamps
 * `session.authenticatedAt` and returns the popup to `/login/reauth`, which
 * reports back to the page that opened it.
 *
 * Returns `{ authorizationUrl }` for the client to navigate to.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = checkAuthRateLimit(request, "sso-oidc-reauth");
  if (rateLimited) return rateLimited;

  // OIDC configured and usable, and an identity linked under its issuer.
  const { methods, sso: settings } = await loadReauthContext(session.userId);
  if (!settings || !methods.includes("oidc")) {
    return NextResponse.json(
      { error: "SSO sign-in is not available for this account" },
      { status: 400 },
    );
  }

  try {
    const discovery = await discoverOidc(settings.oidcIssuer!);
    const { verifier, challenge } = generatePkce();
    const state = generateState();

    session.oidcState = state;
    session.oidcVerifier = verifier;
    session.oidcFlow = "reauth";
    await session.save();

    const url = buildAuthorizationUrl({
      discovery,
      clientId: settings.oidcClientId!,
      redirectUri: resolveRedirectUri(request),
      scope: settings.oidcScopes,
      state,
      codeChallenge: challenge,
      prompt: "login",
    });

    return NextResponse.json({ authorizationUrl: url });
  } catch (error) {
    apiLogger.error("Auth", "OIDC re-authentication init failed", { error: String(error) });
    return NextResponse.json({ error: "Failed to start SSO sign-in" }, { status: 500 });
  }
}
