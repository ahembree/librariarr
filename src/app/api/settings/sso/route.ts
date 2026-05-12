import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, ssoConfigSchema } from "@/lib/validation";
import { sanitize } from "@/lib/api/sanitize";
import { isSsoOverrideActive } from "@/lib/sso/config";

const SSO_SELECT = {
  ssoEnabled: true,
  ssoMode: true,
  oidcIssuer: true,
  oidcClientId: true,
  oidcClientSecret: true,
  oidcScopes: true,
  oidcUsernameClaim: true,
  forwardAuthUserHeader: true,
  forwardAuthEmailHeader: true,
  forwardAuthNameHeader: true,
} as const;

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: SSO_SELECT,
  });

  if (!settings) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...sanitize(settings),
    overrideActive: isSsoOverrideActive(),
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ssoConfigSchema);
  if (error) return error;

  // Load current state so we can validate the requested transition without
  // requiring the client to send the full payload on every PUT.
  const current = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: SSO_SELECT,
  });
  if (!current) {
    return NextResponse.json({ error: "Settings not found" }, { status: 404 });
  }

  const next = { ...current, ...data };

  // Guard: if enabling SSO, require the selected mode to be fully configured,
  // AND require the current admin user to have an SSO subject linked. Without
  // that, enabling SSO would lock the admin out (since SSO replaces local auth).
  if (next.ssoEnabled) {
    if (next.ssoMode === "OIDC") {
      if (!next.oidcIssuer || !next.oidcClientId) {
        return NextResponse.json(
          { error: "OIDC issuer and client ID are required to enable SSO" },
          { status: 400 }
        );
      }
    } else if (next.ssoMode === "FORWARD_AUTH") {
      if (!next.forwardAuthUserHeader) {
        return NextResponse.json(
          { error: "Forward-auth user header is required to enable SSO" },
          { status: 400 }
        );
      }
    }

    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { ssoSubject: true, ssoEnabled: true, plexId: true, passwordHash: true },
    });
    if (!me?.ssoSubject || !me.ssoEnabled) {
      return NextResponse.json(
        {
          error:
            "Link an SSO identity to your account (under SSO Account Linking) before enabling SSO. Otherwise you'd lock yourself out.",
        },
        { status: 400 }
      );
    }
  }

  // Normalize empty strings to null so the OIDC client doesn't try to use them
  const writeData = {
    ssoEnabled: next.ssoEnabled,
    ssoMode: next.ssoMode,
    oidcIssuer: next.oidcIssuer?.trim() || null,
    oidcClientId: next.oidcClientId?.trim() || null,
    // Allow leaving the secret untouched when the masked placeholder is sent
    // back from the client. The `sanitize()` mask is "••••••••" — if we see it
    // (or any all-bullet string), keep the existing secret.
    oidcClientSecret: isMaskedSecret(data.oidcClientSecret)
      ? current.oidcClientSecret
      : data.oidcClientSecret?.trim() || null,
    oidcScopes: next.oidcScopes,
    oidcUsernameClaim: next.oidcUsernameClaim,
    forwardAuthUserHeader: next.forwardAuthUserHeader,
    forwardAuthEmailHeader: next.forwardAuthEmailHeader,
    forwardAuthNameHeader: next.forwardAuthNameHeader,
  };

  const updated = await prisma.appSettings.update({
    where: { userId: session.userId },
    data: writeData,
    select: SSO_SELECT,
  });

  return NextResponse.json({
    ...sanitize(updated),
    overrideActive: isSsoOverrideActive(),
  });
}

function isMaskedSecret(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^•+$/.test(value);
}
