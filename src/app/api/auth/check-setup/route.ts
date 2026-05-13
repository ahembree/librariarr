import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSsoSettings, isSsoOverrideActive, isSsoUsable } from "@/lib/sso/config";

export async function GET() {
  const userCount = await prisma.user.count();
  let localAuthEnabled = false;
  let plexLoginEnabled = true;
  let ssoEnabled = false;
  let ssoMode: "OIDC" | "FORWARD_AUTH" = "OIDC";

  if (userCount > 0) {
    const settings = await prisma.appSettings.findFirst({
      select: { localAuthEnabled: true, plexLoginEnabled: true },
    });
    localAuthEnabled = settings?.localAuthEnabled ?? false;
    plexLoginEnabled = settings?.plexLoginEnabled ?? true;

    const ssoSettings = await getSsoSettings();
    if (isSsoUsable(ssoSettings)) {
      ssoEnabled = true;
      ssoMode = ssoSettings!.ssoMode;
      // SSO replaces local username/password — hide the local form on login.
      localAuthEnabled = false;
    }

    // Break-glass: when SSO_DISABLE_OVERRIDE is set, surface every credential
    // the user has so they can recover. Without this, an admin who set up
    // SSO-only login (plexLoginEnabled=false, localAuthEnabled=false because
    // SSO hid it) would still see a near-empty login page after enabling the
    // override — the override only flips ssoEnabled. Force the other toggles
    // visible so the user can actually log in with whatever credentials they
    // have. Stored DB values are untouched.
    if (isSsoOverrideActive()) {
      localAuthEnabled = settings?.localAuthEnabled ?? false;
      plexLoginEnabled = true;
    }
  }

  return NextResponse.json({
    setupRequired: userCount === 0,
    localAuthEnabled,
    plexLoginEnabled,
    ssoEnabled,
    ssoMode,
  });
}
