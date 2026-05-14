import { createHash, randomBytes } from "crypto";
import { appCache } from "@/lib/cache/memory-cache";

/**
 * Minimal OIDC client for the Authorization Code + PKCE flow.
 *
 * Rather than verifying ID Token JWT signatures, we exchange the code for an
 * access token over HTTPS and then call the issuer's `userinfo_endpoint`. This
 * keeps the implementation small (no JWT library) while remaining secure: TLS
 * authenticates the issuer, the access token came from a fresh code exchange,
 * and PKCE binds the exchange to this client instance.
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OidcUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  [key: string]: unknown;
}

export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

/** Discovery response TTL. OIDC providers publish a stable document, so an
 *  hour is conservative. Admin saves to /api/settings/sso invalidate this
 *  cache so changes take effect immediately. */
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_CACHE_PREFIX = "sso:oidc-discovery:";

/** Invalidate every cached OIDC discovery entry. Called when the admin saves
 *  SSO settings so a config change isn't masked by a stale discovery doc. */
export function invalidateOidcDiscoveryCache(): void {
  appCache.invalidatePrefix(DISCOVERY_CACHE_PREFIX);
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface DiscoverOptions {
  /** Bypass the in-process cache and force a fresh fetch. Used by the
   *  Test Discovery endpoint so admins see live results. */
  skipCache?: boolean;
}

export async function discoverOidc(
  issuer: string,
  options: DiscoverOptions = {}
): Promise<OidcDiscovery> {
  const base = normalizeIssuer(issuer);
  const cacheKey = DISCOVERY_CACHE_PREFIX + base;

  if (!options.skipCache) {
    const cached = appCache.get<OidcDiscovery>(cacheKey);
    if (cached) return cached;
  }

  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (${res.status}): ${url}`
    );
  }
  const config = (await res.json()) as OidcDiscovery;
  if (!config.authorization_endpoint || !config.token_endpoint) {
    throw new Error("OIDC discovery response missing required endpoints");
  }
  // OIDC Discovery §4.3 (and RFC 8414 §3.3) require the `issuer` value in the
  // response to match the URL the client used to fetch the document. Catches
  // misconfiguration (wrong path) and a class of host-header attacks where a
  // misbehaving IdP advertises a different issuer than expected.
  if (config.issuer && normalizeIssuer(config.issuer) !== base) {
    throw new Error(
      `OIDC issuer mismatch: discovery advertises "${config.issuer}" but was fetched from "${base}"`
    );
  }

  if (!options.skipCache) {
    appCache.set(cacheKey, config, DISCOVERY_CACHE_TTL_MS);
  }
  return config;
}

/** URL-safe base64 (RFC 7636 §4.2). */
function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(24));
}

export function buildAuthorizationUrl(opts: {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(opts.discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCodeForToken(opts: {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret?: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (opts.clientSecret) {
    // Send via Authorization header (client_secret_basic) — the most widely
    // supported authentication method. Falls back to nothing for public clients.
    const credentials = Buffer.from(
      `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`
    ).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  }

  const res = await fetchWithTimeout(opts.discovery.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Token exchange failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  return (await res.json()) as OidcTokenResponse;
}

export async function fetchUserInfo(
  discovery: OidcDiscovery,
  accessToken: string
): Promise<OidcUserInfo> {
  if (!discovery.userinfo_endpoint) {
    throw new Error("OIDC provider does not expose a userinfo endpoint");
  }
  const res = await fetchWithTimeout(discovery.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Userinfo request failed (${res.status}): ${text.slice(0, 200)}`
    );
  }
  const info = (await res.json()) as OidcUserInfo;
  if (info.sub === undefined || info.sub === null || info.sub === "") {
    throw new Error("Userinfo response missing required `sub` claim");
  }
  // JSON permits non-string scalars; some providers return `sub` as a number.
  // Coerce defensively so the downstream DB lookup matches what was stored.
  return { ...info, sub: String(info.sub) };
}

/**
 * Resolve the redirect URI used for OIDC callbacks. Honors X-Forwarded-* headers
 * when present (common behind reverse proxies); otherwise falls back to the
 * incoming request's origin. The path is always `/api/auth/sso/oidc/callback`.
 */
export function resolveRedirectUri(request: Request): string {
  const headers = request.headers;
  const forwardedProto = headers.get("x-forwarded-proto");
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}/api/auth/sso/oidc/callback`;
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/api/auth/sso/oidc/callback`;
}
