import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

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

/**
 * Break-glass: when set to a truthy value, force SSO off regardless of the
 * stored AppSettings. This is the only recovery path for an admin who has no
 * Plex account linked and whose SSO provider is unreachable. Requires a
 * container restart to flip; the stored DB config is left intact so the admin
 * can re-enable SSO simply by unsetting the variable.
 */
export function isSsoOverrideActive(): boolean {
  const raw = process.env.SSO_DISABLE_OVERRIDE;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

let overrideWarningLogged = false;

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

  const ssoMode: SsoSettings["ssoMode"] =
    settings.ssoMode === "FORWARD_AUTH" ? "FORWARD_AUTH" : "OIDC";

  if (isSsoOverrideActive()) {
    if (!overrideWarningLogged) {
      logger.warn(
        "sso",
        "SSO_DISABLE_OVERRIDE is active — SSO login is forcibly disabled. " +
          "The stored configuration is preserved; unset the env var to re-enable."
      );
      overrideWarningLogged = true;
    }
    return { ...settings, ssoMode, ssoEnabled: false };
  }

  return { ...settings, ssoMode };
}

/** Returns true if SSO is enabled AND fully configured for its selected mode. */
export function isSsoUsable(settings: SsoSettings | null): boolean {
  if (!settings || !settings.ssoEnabled) return false;
  if (settings.ssoMode === "OIDC") {
    return Boolean(settings.oidcIssuer && settings.oidcClientId);
  }
  return Boolean(settings.forwardAuthUserHeader);
}
