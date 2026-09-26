import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  RateLimiter,
  apiKeyCredentialFailureLimiter,
  apiKeyFailureLogLimiter,
  apiKeyRequestLimiter,
  getClientIp,
} from "@/lib/rate-limit/rate-limiter";
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  API_KEY_PREFIX,
  containsApiKey,
  hashApiKey,
  isWellFormedApiKey,
} from "./keys";
import { runAsApiKey, type ApiKeyPrincipal } from "./principal";
import { isApiScope, type ApiScope } from "./scopes";

/**
 * The `/api/v1` authentication boundary.
 *
 * Every public API handler is `withApiKey(scope, handler)`. The wrapper:
 *   1. refuses a key sent in the URL (it would be in every log it passed);
 *   2. reads the key from `Authorization: Bearer …` or `X-Api-Key` — never from
 *      a cookie, so a logged-in browser cannot be made to call the API (no
 *      ambient credential means no CSRF);
 *   3. looks it up by SHA-256 hash, on every request — nothing is cached, so a
 *      deleted key stops working on its very next request;
 *   4. rejects an expired key, then a key lacking the handler's scope;
 *   5. runs the handler as the key's owner (`runAsApiKey`), which is how a
 *      handler shared with the app's own UI sees an authenticated user.
 *
 * Only routes under `src/app/api/v1` use this, so a key cannot reach any other
 * route: those read the cookie session, which a key never has.
 */

const REALM = 'Bearer realm="Librariarr"';

/**
 * Query parameters a client might put a key in (compared case-insensitively).
 * A URL carrying one — or carrying anything shaped like a key, under any name
 * or in the path — is refused outright rather than ignored: a URL is written to
 * proxy logs, browser history and `Referer` headers, so the key is already
 * exposed and the caller needs to hear it.
 */
const KEY_QUERY_PARAMS = new Set(["api_key", "apikey", "api-key", "x-api-key", "access_token"]);

/** How stale `lastUsedAt` may get before a request refreshes it. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

/**
 * A valid key refused for its scope or its request budget is logged at WARN —
 * a read-only key probing write endpoints is exactly what an audit log is for —
 * but once per key and reason per 15 minutes, so a misconfigured client
 * retrying every few seconds cannot bury System Logs. Bounded by keys × scopes.
 */
const refusalLogThrottle = new RateLimiter(1, 15 * 60 * 1000);

function warnOnce(throttleKey: string, message: string): void {
  if (!refusalLogThrottle.check(throttleKey).limited) apiLogger.warn("API", message);
}

const API_KEY_GUARD = Symbol.for("librariarr.apiKeyGuard");

export interface ApiKeyGuardInfo {
  /** The scope the handler requires; `null` = any valid key (introspection). */
  scope: ApiScope | null;
}

type RouteHandler<C> = (request: NextRequest, context: C) => Response | Promise<Response>;

// A handler without a route context keeps its one-parameter shape; one with
// dynamic segments keeps its `{ params }` context type.
export function withApiKey(
  scope: ApiScope | null,
  handler: (request: NextRequest) => Response | Promise<Response>,
): (request: NextRequest) => Promise<Response>;
export function withApiKey<C>(
  scope: ApiScope | null,
  handler: RouteHandler<C>,
): (request: NextRequest, context: C) => Promise<Response>;
export function withApiKey<C>(
  scope: ApiScope | null,
  handler: RouteHandler<C>,
): (request: NextRequest, context: C) => Promise<Response> {
  if (scope !== null && !isApiScope(scope)) {
    throw new Error(`Unknown API scope "${String(scope)}"`);
  }

  const guarded = async (request: NextRequest, context: C): Promise<Response> => {
    const auth = await authenticateApiKey(request, scope);
    if (!auth.ok) return auth.response;

    let status: number | "error" = "error";
    try {
      const response = await runAsApiKey(auth.principal, () => handler(request, context));
      status = response.status;
      return withApiResponseHeaders(response);
    } finally {
      auditRequest(request, auth.principal, status);
    }
  };

  Object.defineProperty(guarded, API_KEY_GUARD, {
    value: Object.freeze({ scope } satisfies ApiKeyGuardInfo),
  });
  return guarded;
}

/** The guard a handler was wrapped with, or `undefined` for an unguarded one. */
export function getApiKeyGuard(handler: unknown): ApiKeyGuardInfo | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, ApiKeyGuardInfo | undefined>)[API_KEY_GUARD];
}

export type ApiKeyAuthResult =
  | { ok: true; principal: ApiKeyPrincipal }
  | { ok: false; response: Response };

export async function authenticateApiKey(
  request: NextRequest,
  scope: ApiScope | null,
): Promise<ApiKeyAuthResult> {
  if (urlCarriesKey(request.nextUrl)) {
    return refuse(
      400,
      "Send the API key in the Authorization or X-Api-Key header, never in the URL, where it is written to logs and browser history. If a real key was sent this way, delete it and create a new one.",
    );
  }

  const credential = readCredential(request);
  if (credential.conflict) {
    return refuse(400, "The Authorization and X-Api-Key headers carry different keys. Send one.");
  }
  if (!credential.key) {
    return refuse(401, "API key required", { "WWW-Authenticate": REALM });
  }

  const ip = getClientIp(request);
  const keyHash = hashApiKey(credential.key);

  // Keyed by the credential alone and charged only on failure: a credential
  // that keeps failing is refused without a lookup, and a valid key — which
  // never fails — can never be locked out by anyone else's failures.
  const blocked = apiKeyCredentialFailureLimiter.peek(keyHash);
  if (blocked.limited) return tooManyRequests(blocked.retryAfterMs);

  const invalid = (reason: string, message = "Invalid API key"): ApiKeyAuthResult => {
    recordFailure(ip, keyHash, reason);
    return refuse(401, message, { "WWW-Authenticate": `${REALM}, error="invalid_token"` });
  };

  if (!isWellFormedApiKey(credential.key)) return invalid("not a Librariarr API key");

  let row: {
    id: string;
    userId: string;
    name: string;
    prefix: string;
    scopes: string[];
    expiresAt: Date | null;
    lastUsedAt: Date | null;
  } | null;
  try {
    row = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        userId: true,
        name: true,
        prefix: true,
        scopes: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    });
  } catch (error) {
    // Fail closed. The detail stays in the log; the caller learns nothing.
    apiLogger.error("API", "API key lookup failed", { error: String(error) });
    return refuse(503, "Authentication is temporarily unavailable");
  }

  if (!row) {
    return invalid(
      `unknown key ${credential.key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH)}… (deleted, or never issued)`,
    );
  }

  const now = new Date();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return invalid(`API key "${row.name}" (${row.prefix}…) has expired`, "API key has expired");
  }

  const rate = apiKeyRequestLimiter.check(row.id);
  if (rate.limited) {
    warnOnce(
      `rate:${row.id}`,
      `API key "${row.name}" (${row.prefix}…) went over ${apiKeyRequestLimiter.maxAttempts} requests a minute — refusing its requests until the minute is up`,
    );
    return tooManyRequests(rate.retryAfterMs);
  }

  // A scope string this version does not recognise grants nothing.
  const scopes = row.scopes.filter(isApiScope);
  if (scope !== null && !scopes.includes(scope)) {
    warnOnce(
      `scope:${row.id}:${scope}`,
      `API key "${row.name}" (${row.prefix}…) was refused ${request.method} ${request.nextUrl.pathname}: it does not have the "${scope}" scope`,
    );
    return refuse(
      403,
      `This API key does not have the "${scope}" scope`,
      { "WWW-Authenticate": `${REALM}, error="insufficient_scope", scope="${scope}"` },
      { requiredScope: scope },
    );
  }

  await touchLastUsed(row.id, row.lastUsedAt, now, ip);

  return {
    ok: true,
    principal: {
      keyId: row.id,
      userId: row.userId,
      name: row.name,
      prefix: row.prefix,
      scopes,
    },
  };
}

function urlCarriesKey(url: URL): boolean {
  if (containsApiKey(url.pathname)) return true;
  for (const [name, value] of url.searchParams) {
    if (KEY_QUERY_PARAMS.has(name.toLowerCase())) return true;
    if (containsApiKey(name) || containsApiKey(value)) return true;
  }
  return false;
}

function readCredential(request: NextRequest): { key?: string; conflict?: boolean } {
  // Only a Bearer credential counts, and only an `lbr_` one when `X-Api-Key` is
  // also present. A reverse proxy authenticating in front of Librariarr puts
  // its OWN credential in `Authorization` — HTTP Basic, or the Bearer JWT an
  // oauth2-proxy / forward-auth setup injects — and the client then sends the
  // key in `X-Api-Key`; that must work rather than read as two different keys.
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1];
  const headerKey = request.headers.get("x-api-key")?.trim() || undefined;
  if (bearer && headerKey && bearer !== headerKey) {
    if (!bearer.startsWith(API_KEY_PREFIX)) return { key: headerKey };
    if (!headerKey.startsWith(API_KEY_PREFIX)) return { key: bearer };
    return { conflict: true };
  }
  return { key: bearer ?? headerKey };
}

/**
 * Count a failed attempt. Logged at WARN the first time a credential fails in
 * its window (a deleted key still in some client's config shows up in System
 * Logs once, not every ten seconds) while the window's WARN budget lasts, and
 * at DEBUG otherwise — so a flood of distinct junk keys cannot become a flood
 * of log rows. The presented value itself is never logged.
 */
function recordFailure(ip: string, keyHash: string, reason: string): void {
  const credential = apiKeyCredentialFailureLimiter.check(keyHash);
  const message = `Rejected an API request from ${ipLiteral(ip) ?? "an unknown address"}: ${reason}`;
  if (credential.remaining !== apiKeyCredentialFailureLimiter.maxAttempts - 1) {
    apiLogger.debug("API", message);
    return;
  }
  const budget = apiKeyFailureLogLimiter.check("failures");
  if (budget.limited) {
    apiLogger.debug("API", message);
  } else if (budget.remaining === 0) {
    apiLogger.warn(
      "API",
      `${message} — failed API key attempts are arriving faster than is useful to log; the rest in this 15-minute window go to DEBUG`,
    );
  } else {
    apiLogger.warn("API", message);
  }
}

/**
 * Refresh `lastUsedAt`/`lastUsedIp` at most once a minute per key, so a busy
 * integration does not turn every read into a write. The conditional `where`
 * keeps concurrent requests from all writing. Bookkeeping only — a failure
 * here must never fail the request.
 */
async function touchLastUsed(
  keyId: string,
  lastUsedAt: Date | null,
  now: Date,
  ip: string,
): Promise<void> {
  if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
  const staleBefore = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS);
  try {
    await prisma.apiKey.updateMany({
      where: { id: keyId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }] },
      data: { lastUsedAt: now, lastUsedIp: ipLiteral(ip) },
    });
  } catch {
    // Ignore — see above.
  }
}

/**
 * The client address as it may be logged or stored, or null. It comes from a
 * proxy header, so where no trusted proxy rewrites that header it is whatever
 * the client typed — only an IPv4/IPv6 literal (with an optional zone) is
 * written anywhere, never free text that could pose as part of a log line.
 */
function ipLiteral(ip: string): string | null {
  return /^[0-9A-Fa-f:.]{2,45}(%[0-9A-Za-z_.-]{1,16})?$/.test(ip) ? ip : null;
}

function auditRequest(
  request: NextRequest,
  principal: ApiKeyPrincipal,
  status: number | "error",
): void {
  const line = `${request.method} ${request.nextUrl.pathname} → ${status} (API key "${principal.name}", ${principal.prefix}…)`;
  // Reads are what dashboards poll; recording each at INFO would bury the log.
  // Anything that can change state is always recorded.
  if (request.method === "GET" || request.method === "HEAD") apiLogger.debug("API", line);
  else apiLogger.info("API", line);
}

/**
 * API responses must never be stored by a shared cache: a proxy serving one
 * key's response to another client (or to no key at all) would be an
 * authentication bypass. `no-store` where the handler set nothing, and a
 * handler's `public` (artwork) downgraded to `private`, which still lets the
 * calling client cache it.
 */
function withApiResponseHeaders(response: Response): Response {
  try {
    const cacheControl = response.headers.get("cache-control");
    if (!cacheControl) {
      response.headers.set("Cache-Control", "no-store");
    } else if (/\bpublic\b/i.test(cacheControl)) {
      response.headers.set("Cache-Control", cacheControl.replace(/\bpublic\b/gi, "private"));
    }
  } catch {
    // Immutable headers (a proxied fetch Response) — leave them as they are.
  }
  return response;
}

function refuse(
  status: number,
  error: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): { ok: false; response: Response } {
  return {
    ok: false,
    response: NextResponse.json(
      { error, ...extra },
      { status, headers: { "Cache-Control": "no-store", ...headers } },
    ),
  };
}

function tooManyRequests(retryAfterMs: number | undefined): { ok: false; response: Response } {
  return refuse(429, "Too many requests. Try again later.", {
    "Retry-After": String(Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))),
  });
}
