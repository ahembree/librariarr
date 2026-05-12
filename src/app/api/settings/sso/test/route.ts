import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, ssoTestSchema } from "@/lib/validation";
import { discoverOidc } from "@/lib/sso/oidc-client";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ssoTestSchema);
  if (error) return error;

  try {
    const discovery = await discoverOidc(data.oidcIssuer);
    return NextResponse.json({
      ok: true,
      issuer: discovery.issuer,
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
      userinfoEndpoint: discovery.userinfo_endpoint ?? null,
      scopesSupported: discovery.scopes_supported ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: sanitizeErrorDetail(String(err)) ?? "Discovery failed" },
      { status: 200 }
    );
  }
}
