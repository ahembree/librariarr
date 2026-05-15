import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSsoSettings, isSsoOverrideActive, isSsoUsable } from "@/lib/sso/config";

export async function GET() {
  const userCount = await prisma.user.count();
  let localAuthEnabled = false;
  let plexLoginEnabled = false;
  let ssoEnabled = false;
  let ssoMode: "OIDC" | "FORWARD_AUTH" = "OIDC";

  if (userCount > 0) {
    // Single-user app: find the admin and read their state + their AppSettings
    // in one query. The login page needs to know which credential methods the
    // admin actually has, not just which toggles are flipped — e.g. Plex login
    // shouldn't show when no Plex account is linked because the button would
    // immediately fail with "not linked to admin user."
    const user = await prisma.user.findFirst({
      select: {
        plexId: true,
        appSettings: {
          select: { localAuthEnabled: true, plexLoginEnabled: true },
        },
      },
    });

    const hasPlexLinked = !!user?.plexId;
    localAuthEnabled = user?.appSettings?.localAuthEnabled ?? false;
    // Plex button only when (a) a Plex account is linked AND (b) the admin
    // hasn't explicitly hidden the button. Local-first setups have no
    // plexId by default, so the button stays hidden until the admin
    // explicitly links Plex from Settings → Authentication.
    plexLoginEnabled =
      hasPlexLinked && (user?.appSettings?.plexLoginEnabled ?? true);

    const ssoSettings = await getSsoSettings();
    if (isSsoUsable(ssoSettings)) {
      ssoEnabled = true;
      ssoMode = ssoSettings!.ssoMode;
      // SSO replaces local username/password — hide the local form on login.
      localAuthEnabled = false;
    }

    // Break-glass: when SSO_DISABLE_OVERRIDE is set, surface every credential
    // the user actually has so they can recover. Override forces SSO off
    // (already handled by getSsoSettings). For Plex login it only matters
    // if the admin has actually linked Plex — otherwise the button would
    // appear but be unusable. Same gate.
    if (isSsoOverrideActive()) {
      localAuthEnabled = user?.appSettings?.localAuthEnabled ?? false;
      plexLoginEnabled = hasPlexLinked;
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
