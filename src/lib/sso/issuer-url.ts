/**
 * The one rule for an OIDC issuer URL, shared by the settings schemas
 * (`ssoConfigSchema`, `ssoTestSchema`), `isSsoUsable` and `discoverOidc`:
 * `https://`, with `http://` accepted only for a loopback host — or anywhere
 * while `OIDC_ALLOW_INSECURE_HTTP` is set, an explicit opt-in for a lab.
 *
 * The OIDC client deliberately verifies no ID token signature: it exchanges
 * the code over TLS and reads the userinfo endpoint, and TLS is what
 * authenticates the issuer. Over plain HTTP that assumption is simply false —
 * the client secret (HTTP Basic on the token request), the code, the access
 * token and the userinfo answer are all readable and replaceable by whoever is
 * on the path to the IdP, and a replaced userinfo answer IS an admin login.
 * Verifying the ID token would not rescue it either, with the JWKS fetched
 * over the same connection. Loopback is the one host no network sits between.
 *
 * Client-safe: no Node imports, so the validation schemas can be bundled.
 */
import { isTruthyFlag } from "@/lib/env-flag";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const OIDC_INSECURE_HTTP_ENV = "OIDC_ALLOW_INSECURE_HTTP";

/** A host no network sits between: `localhost`, `*.localhost`, 127/8, ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function insecureHttpAllowed(env: NodeJS.ProcessEnv | undefined = typeof process === "undefined" ? undefined : process.env): boolean {
  return isTruthyFlag(env?.[OIDC_INSECURE_HTTP_ENV]);
}

/**
 * Why `value` is not accepted as an OIDC issuer URL, or null when it is. The
 * message is shown to the admin as it is.
 */
export function oidcIssuerProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Issuer must be a URL starting with https://";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "Issuer must be a URL starting with https://";
  if (isLoopbackHost(url.hostname) || insecureHttpAllowed()) return null;
  return (
    "Issuer must use https:// — over plain HTTP anyone on the path to the identity provider could sign in as you. " +
    `An http:// issuer is accepted only on localhost, or with ${OIDC_INSECURE_HTTP_ENV}=true set on the container.`
  );
}
