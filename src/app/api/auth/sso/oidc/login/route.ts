import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";
import {
  buildAuthorizationUrl,
  discoverOidc,
  generatePkce,
  generateState,
  resolveRedirectUri,
} from "@/lib/sso/oidc-client";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

/**
 * Initiates the OIDC Authorization Code + PKCE flow. The PKCE verifier and
 * `state` value are stashed in the encrypted session cookie so the callback
 * can verify them without server-side state.
 *
 * Returns 302 to the IdP authorization endpoint.
 */
export async function GET(request: NextRequest) {
  const rateLimited = checkAuthRateLimit(request, "sso-oidc-init");
  if (rateLimited) return rateLimited;

  const settings = await getSsoSettings();
  if (!isSsoUsable(settings) || settings?.ssoMode !== "OIDC") {
    return NextResponse.json(
      { error: "OIDC SSO is not configured" },
      { status: 400 }
    );
  }

  try {
    const discovery = await discoverOidc(settings.oidcIssuer!);
    const { verifier, challenge } = generatePkce();
    const state = generateState();

    const session = await getSession();
    session.oidcState = state;
    session.oidcVerifier = verifier;
    await session.save();

    const url = buildAuthorizationUrl({
      discovery,
      clientId: settings.oidcClientId!,
      redirectUri: resolveRedirectUri(request),
      scope: settings.oidcScopes,
      state,
      codeChallenge: challenge,
    });

    return NextResponse.redirect(url);
  } catch (error) {
    apiLogger.error("Auth", "OIDC init failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to initiate SSO login" },
      { status: 500 }
    );
  }
}
