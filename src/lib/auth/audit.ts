import { apiLogger } from "@/lib/logger";
import { auditAddress } from "@/lib/rate-limit/client-ip";

/**
 * The audit lines for sign-ins.
 *
 * A wrong password, an unknown username and a refused Plex or SSO identity
 * used to answer 401/403 and log nothing, so a guessing run against the one
 * admin account left no record anywhere. Every failure is a WARN carrying the
 * client address the rate limiter buckets by; the limiter bounds how many
 * there can be (and logs the lockout itself, once per window).
 *
 * The attempted username or password is never logged: a password typed into
 * the wrong field would end up in the log table and in every backup.
 */
export type SignInMethod = "password" | "Plex" | "OIDC" | "forward-auth";

export function logSignInFailure(
  request: Request,
  method: SignInMethod,
  reason: string,
  meta?: Record<string, unknown>,
): void {
  apiLogger.warn("Auth", `Failed sign-in (${method}): ${reason}`, { address: auditAddress(request), ...meta });
}

/** The address to attach to a sign-in or security-settings log line. */
export function auditMeta(request: Request): { address: string } {
  return { address: auditAddress(request) };
}

/**
 * One line for a change to how the instance is signed into, where its
 * credentials go, or what it keeps on record: sign-in and SSO settings, the
 * Discord webhook, the AI provider, backups, integrations and media servers,
 * log retention. These used to be silent, so a stolen cookie could re-point
 * the Discord webhook or switch off the API-key alert and leave nothing to
 * find. Source `Audit`, so System Logs can filter to them. Never pass a
 * secret, or a URL that is one (a webhook), in `meta`.
 */
export function logSecurityChange(request: Request, message: string, meta?: Record<string, unknown>): void {
  apiLogger.info("Audit", message, { address: auditAddress(request), ...meta });
}
