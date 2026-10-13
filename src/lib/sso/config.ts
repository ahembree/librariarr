import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isForwardAuthSecretConfigured } from "@/lib/sso/forward-secret";
import { oidcIssuerProblem } from "@/lib/sso/issuer-url";

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
let unusableWarningLogged = false;

/** Anything that can read AppSettings: the client, or a transaction's. */
export type SettingsReader = Pick<Prisma.TransactionClient, "appSettings">;

/**
 * Load SSO configuration from the singleton AppSettings row (or null if no
 * admin yet). `db` is a transaction's client when the read must see what that
 * transaction's lock guarantees (see `lockSignInSettings`).
 */
export async function getSsoSettings(db: SettingsReader = prisma): Promise<SsoSettings | null> {
  const settings = await db.appSettings.findFirst({
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

  const effective: SsoSettings = { ...settings, ssoMode };
  // SSO is on in the database but refused here (ssoUnusableReason): an install
  // upgraded past the requirement, most likely. Said once, loudly, because the
  // login page silently shows the local form or the Plex button instead.
  const reason = settings.ssoEnabled ? ssoUnusableReason(effective) : null;
  if (reason && !unusableWarningLogged) {
    logger.error("sso", `SSO login is turned on but cannot be offered: ${reason}`);
    unusableWarningLogged = true;
  }

  return effective;
}

/**
 * Why SSO, with `ssoEnabled` taken as given, cannot be offered — or null when
 * it can. The requirements beyond the fields being filled in:
 *
 * - OIDC: the issuer must be an `https://` URL (loopback excepted, or
 *   `OIDC_ALLOW_INSECURE_HTTP`): the client verifies no ID token signature and
 *   relies on TLS to authenticate the issuer, so over plain HTTP whoever is on
 *   the path to the IdP signs in as the admin (`src/lib/sso/issuer-url.ts`).
 * - Forward-auth: `FORWARD_AUTH_SECRET` must be set, or anyone who reaches the
 *   app's port directly signs in by sending the identity header themselves
 *   (`src/lib/sso/forward-secret.ts`).
 *
 * `PUT /api/settings/sso` refuses to turn SSO on against either, so the only
 * way to be here with a reason is an upgrade or a changed environment — and
 * then the failsafe is the right one: SSO is not offered, so the local form or
 * the Plex button is, and the admin is not locked out while fixing it.
 */
export function ssoUnusableReason(settings: SsoSettings): string | null {
  if (settings.ssoMode === "OIDC") {
    if (!settings.oidcIssuer || !settings.oidcClientId) return "the OIDC issuer and client ID are not both set";
    const problem = oidcIssuerProblem(settings.oidcIssuer);
    return problem ? `the OIDC issuer URL is not accepted: ${problem}` : null;
  }
  if (!settings.forwardAuthUserHeader) return "no forward-auth user header is set";
  if (!isForwardAuthSecretConfigured()) {
    return "FORWARD_AUTH_SECRET is not set, so a request cannot be told apart from one that bypassed the proxy";
  }
  return null;
}

/** Returns true if SSO is enabled AND fully configured for its selected mode. */
export function isSsoUsable(settings: SsoSettings | null): boolean {
  if (!settings || !settings.ssoEnabled) return false;
  return ssoUnusableReason(settings) === null;
}

/**
 * Compute the canonical issuer string we store in `User.ssoIssuer` for the
 * currently-configured SSO mode. The OIDC issuer URL is normalized (trailing
 * slashes stripped) so it round-trips against `discoverOidc`'s normalization.
 * Forward-auth uses a literal sentinel — there's no per-IdP issuer in that
 * mode, but we still want a deterministic value so cross-mode collisions
 * (OIDC sub "x" vs forward-auth user "x") are impossible.
 */
export function currentSsoIssuer(settings: SsoSettings | null): string | null {
  if (!settings) return null;
  if (settings.ssoMode === "OIDC") {
    if (!settings.oidcIssuer) return null;
    return settings.oidcIssuer.replace(/\/+$/, "");
  }
  return "forward-auth";
}
