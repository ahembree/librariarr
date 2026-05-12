import { prisma } from "@/lib/db";

export interface SsoSettings {
  ssoEnabled: boolean;
  ssoMode: "OIDC" | "FORWARD_AUTH";
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  oidcScopes: string;
  oidcUsernameClaim: string;
  forwardAuthUserHeader: string;
  forwardAuthEmailHeader: string;
  forwardAuthNameHeader: string;
}

/** Load SSO configuration from the singleton AppSettings row (or null if no admin yet). */
export async function getSsoSettings(): Promise<SsoSettings | null> {
  const settings = await prisma.appSettings.findFirst({
    select: {
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
    },
  });
  if (!settings) return null;
  return {
    ...settings,
    ssoMode: settings.ssoMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC",
  };
}

/** Returns true if SSO is enabled AND fully configured for its selected mode. */
export function isSsoUsable(settings: SsoSettings | null): boolean {
  if (!settings || !settings.ssoEnabled) return false;
  if (settings.ssoMode === "OIDC") {
    return Boolean(settings.oidcIssuer && settings.oidcClientId);
  }
  return Boolean(settings.forwardAuthUserHeader);
}
