/**
 * The one reading of an on/off environment variable: `true`, `1` or `yes`,
 * case-insensitive and trimmed, is on; anything else (unset included) is off.
 * Shared by `SSO_DISABLE_OVERRIDE` and `OIDC_ALLOW_INSECURE_HTTP`, so the two
 * cannot accept different spellings. Client-safe: no Node imports.
 */
export function isTruthyFlag(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}
