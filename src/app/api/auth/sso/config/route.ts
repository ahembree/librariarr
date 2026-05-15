import { NextResponse } from "next/server";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";

/**
 * Public endpoint consumed by the login page to decide which auth methods to
 * render. Reveals only the boolean enable state and the selected mode — no
 * issuer URLs, client IDs, or header names are exposed unauthenticated.
 */
export async function GET() {
  const settings = await getSsoSettings();
  const usable = isSsoUsable(settings);
  return NextResponse.json({
    ssoEnabled: usable,
    ssoMode: settings?.ssoMode ?? "OIDC",
  });
}
