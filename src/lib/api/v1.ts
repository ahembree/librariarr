/**
 * The `/api/v1` public API contract, in one place.
 *
 * Every v1 route is wrapped by {@link withApiKey}, which is the *only* place
 * key authentication, scope enforcement and rate limiting live. Routes get a
 * pre-authenticated context and a fixed error shape, so the security posture of
 * the whole surface is one function rather than 20 copies of an `if` block that
 * can drift. `/api/v1/health` is the single deliberate exception and is written
 * as a plain handler.
 *
 * This is separate from the internal `/api/*` routes, which stay session-
 * authenticated for the web UI. A read-only key must never be able to reach an
 * internal mutation route, so the two surfaces do not share an auth path.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { ApiKey, ApiKeyScope } from "@/generated/prisma/client";
import { authenticateApiKey, requireScope } from "@/lib/auth/api-key";
import { apiKeyRateLimiter } from "@/lib/rate-limit/rate-limiter";
import { apiLogger } from "@/lib/logger";

/** Everything a v1 handler is handed after authentication succeeds. */
export interface V1Context {
  /** The authenticated key row. */
  apiKey: ApiKey;
  /** Owner of the key — the single admin. Use for all ownership-scoped queries. */
  userId: string;
  /** Dynamic route params, already awaited (Next 16 hands these over as a Promise). */
  params: Record<string, string>;
}

export type V1Handler = (
  request: NextRequest,
  context: V1Context,
) => Promise<Response> | Response;

export interface WithApiKeyOptions {
  /**
   * Set on any endpoint that mutates state. Write endpoints reject `READ_ONLY`
   * keys with 403; read endpoints accept either scope.
   */
  scope?: ApiKeyScope;
}

/** Uniform error body for the whole v1 surface. */
export function v1Error(error: string, status: number, details?: unknown) {
  return NextResponse.json(
    details === undefined ? { error } : { error, details },
    { status },
  );
}

/**
 * Wrap a v1 route handler with API-key authentication, scope enforcement and
 * per-key rate limiting.
 *
 * Usage:
 *   export const GET = withApiKey(async (request, { userId }) => { ... })
 *   export const POST = withApiKey(handler, { scope: "READ_WRITE" })
 *
 * The returned function matches Next.js's route-handler signature, including
 * the `{ params }` second argument for dynamic segments — those are awaited and
 * surfaced on the context so handlers never deal with the Promise themselves.
 */
export function withApiKey(handler: V1Handler, options: WithApiKeyOptions = {}) {
  const needed: ApiKeyScope = options.scope ?? "READ_ONLY";

  return async function wrapped(
    request: NextRequest,
    routeContext?: { params?: Promise<Record<string, string>> },
  ): Promise<Response> {
    const auth = await authenticateApiKey(request);
    if (!auth.ok) {
      // Log rejections (never the presented key) so an admin can see a
      // misconfigured integration in the system log instead of guessing.
      apiLogger.warn("api-v1", `API key rejected (${auth.reason})`, {
        path: new URL(request.url).pathname,
        reason: auth.reason,
      });
      return v1Error(auth.error, auth.status);
    }

    const scopeError = requireScope(auth.apiKey, needed);
    if (scopeError && !scopeError.ok) {
      apiLogger.warn("api-v1", "API key lacks write scope", {
        path: new URL(request.url).pathname,
        keyName: auth.apiKey.name,
      });
      return v1Error(scopeError.error, scopeError.status);
    }

    // Bucket by key id, not by IP: the key is the identity here, and several
    // integrations behind one NAT must not share a budget.
    const limit = apiKeyRateLimiter.check(`api-key:${auth.apiKey.id}`);
    if (limit.limited) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Slow down and try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil((limit.retryAfterMs ?? 0) / 1000)) },
        },
      );
    }

    const params = routeContext?.params ? await routeContext.params : {};

    try {
      return await handler(request, {
        apiKey: auth.apiKey,
        userId: auth.apiKey.userId,
        params,
      });
    } catch (err) {
      // A thrown handler must not leak a stack trace to an external caller.
      apiLogger.error("api-v1", "Unhandled error in v1 route", {
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return v1Error("Internal server error", 500);
    }
  };
}

/**
 * Parse `page`/`limit` for v1 list endpoints.
 *
 * Intentionally stricter than the internal {@link import("./pagination")} parser:
 * the internal one accepts `limit=0` ("return everything") because the library
 * UI needs it for progressive loading. An external caller asking for the entire
 * library in one response is a memory hazard on the server and almost always a
 * mistake, so v1 always has an upper bound and paginates instead.
 */
export const V1_MAX_LIMIT = 200;
export const V1_DEFAULT_LIMIT = 50;

export interface V1Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function parseV1Pagination(searchParams: URLSearchParams): V1Pagination {
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);

  const rawLimit = parseInt(searchParams.get("limit") ?? String(V1_DEFAULT_LIMIT), 10);
  const limit = Number.isNaN(rawLimit)
    ? V1_DEFAULT_LIMIT
    : Math.max(1, Math.min(rawLimit, V1_MAX_LIMIT));

  return { page, limit, skip: (page - 1) * limit };
}

/** Standard paginated envelope. `hasMore` comes from the fetch-limit+1 trick. */
export function v1List<T>(items: T[], pagination: V1Pagination, hasMore: boolean) {
  return NextResponse.json({
    items,
    pagination: { page: pagination.page, limit: pagination.limit, hasMore },
  });
}
