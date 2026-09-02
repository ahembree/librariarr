import type { NextRequest } from "next/server";
import { createTestRequest } from "../../setup/test-helpers";

/**
 * The shape every handler produced by `withApiKey` has. Declaring it here lets
 * the auth matrix iterate over the whole v1 surface in one typed table instead
 * of repeating the same four rejection cases per route file.
 */
export type V1RouteHandler = (
  request: NextRequest,
  routeContext?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;

export interface V1CallOptions {
  url?: string;
  method?: string;
  body?: unknown;
  searchParams?: Record<string, string>;
  params?: Record<string, string>;
  /** Raw key to present. Omit to send no credential at all. */
  key?: string;
  /** Present the key as `Authorization: Bearer` instead of `X-Api-Key`. */
  bearer?: boolean;
  headers?: Record<string, string>;
}

/**
 * Invoke a v1 route the way an external client would.
 *
 * `callRouteWithParams` from the shared helpers can't be used for v1: it has no
 * `headers` option, and a v1 request without a key header is unauthenticated by
 * construction.
 */
export async function callV1(
  handler: V1RouteHandler,
  options: V1CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.key !== undefined) {
    if (options.bearer) headers["Authorization"] = `Bearer ${options.key}`;
    else headers["X-Api-Key"] = options.key;
  }

  const request = createTestRequest(options.url ?? "/api/v1", {
    method: options.method,
    body: options.body,
    searchParams: options.searchParams,
    headers,
  });

  return handler(
    request,
    options.params ? { params: Promise.resolve(options.params) } : undefined,
  );
}
