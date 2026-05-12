import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSsoSettings, isSsoUsable } from "@/lib/sso/config";

export async function GET() {
  const userCount = await prisma.user.count();
  let localAuthEnabled = false;
  let ssoEnabled = false;
  let ssoMode: "OIDC" | "FORWARD_AUTH" = "OIDC";

  if (userCount > 0) {
    const settings = await prisma.appSettings.findFirst({
      select: { localAuthEnabled: true },
    });
    localAuthEnabled = settings?.localAuthEnabled ?? false;

    const ssoSettings = await getSsoSettings();
    if (isSsoUsable(ssoSettings)) {
      ssoEnabled = true;
      ssoMode = ssoSettings!.ssoMode;
      // SSO replaces local username/password — hide the local form on login.
      localAuthEnabled = false;
    }
  }

  return NextResponse.json({
    setupRequired: userCount === 0,
    localAuthEnabled,
    ssoEnabled,
    ssoMode,
  });
}
