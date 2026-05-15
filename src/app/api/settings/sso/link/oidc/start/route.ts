import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { currentSsoIssuer, getSsoSettings } from "@/lib/sso/config";
import {
  buildAuthorizationUrl,
  discoverOidc,
  generatePkce,
  generateState,
  resolveRedirectUri,
} from "@/lib/sso/oidc-client";
import { apiLogger } from "@/lib/logger";

/**
 * Initiates an OIDC flow for the authenticated admin to LINK their identity,
 * not log in. The callback at /api/auth/sso/oidc/callback reads
 * `session.oidcFlow === "link"` to branch into the link path.
 *
 * Why this exists: the manual "paste your sub" flow doesn't verify that the
 * configured client_id + client_secret + redirect URI actually work at the
 * IdP. Admins who typo a client ID can save the config, manually link a
 * sub, enable SSO, log out — and then discover at login time that the
 * credentials are broken. Going through a real OIDC round-trip validates
 * everything end-to-end before SSO is activated.
 *
 * Returns 302 to the IdP's authorization endpoint on success, with the
 * link-flow flag stashed in the encrypted session cookie.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getSsoSettings();
  if (!settings || settings.ssoMode !== "OIDC") {
    return NextResponse.json(
      { error: "OIDC mode must be selected and configured before linking" },
      { status: 400 }
    );
  }
  if (!settings.oidcIssuer || !settings.oidcClientId) {
    return NextResponse.json(
      {
        error:
          "Save the OIDC issuer URL and client ID in step 1 before linking your identity.",
      },
      { status: 400 }
    );
  }
  // currentSsoIssuer normalizes (strips trailing slash). The callback uses
  // the same normalization, so the issuer captured here will round-trip.
  if (!currentSsoIssuer(settings)) {
    return NextResponse.json({ error: "SSO is not configured" }, { status: 400 });
  }

  try {
    const discovery = await discoverOidc(settings.oidcIssuer);
    const { verifier, challenge } = generatePkce();
    const state = generateState();

    session.oidcState = state;
    session.oidcVerifier = verifier;
    session.oidcFlow = "link";
    await session.save();

    const url = buildAuthorizationUrl({
      discovery,
      clientId: settings.oidcClientId,
      redirectUri: resolveRedirectUri(request),
      scope: settings.oidcScopes,
      state,
      codeChallenge: challenge,
    });

    return NextResponse.json({ authorizationUrl: url });
  } catch (error) {
    apiLogger.error("Auth", "OIDC link init failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to initiate OIDC link flow" },
      { status: 500 }
    );
  }
}
