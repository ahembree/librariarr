import type { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/api/json-response";
import { getExternalBaseUrl } from "@/lib/url";
import { buildOpenApiDocument } from "./openapi";

export const OPENAPI_FILENAME = "librariarr-openapi.json";

export interface OpenApiResponseOptions {
  /**
   * Serve the `servers` URL as the relative `/api/v1`, for the in-app Swagger
   * viewer. A relative URL resolves against the page's own address, while the
   * absolute one is built from `X-Forwarded-*`: behind a proxy that terminates
   * TLS without sending `X-Forwarded-Proto` it reads `http://`, and the browser
   * blocks every Try it out request from the https page as mixed content. A
   * download keeps the absolute URL, since a saved file has no address to
   * resolve against — and so does `/api/v1/openapi.json`, which API tooling
   * reads, where no browser page is involved.
   */
  relativeServer?: boolean;
}

/**
 * The OpenAPI document as a response, built for THIS request: the `servers`
 * URL is the address the request arrived on (or relative, see
 * `relativeServer`), and the version is the running app's. Nothing is stored
 * on disk, so it cannot go stale. `?download=1` hands the browser a file
 * instead of a page. Sent through `jsonResponse`: the document is tens of KB,
 * and Route Handler responses are otherwise uncompressed.
 */
export function openApiResponse(request: NextRequest, options: OpenApiResponseOptions = {}): Promise<Response> {
  const download = request.nextUrl.searchParams.get("download") === "1";
  const relative = options.relativeServer === true && !download;
  const document = buildOpenApiDocument(
    relative ? "" : getExternalBaseUrl(request),
    process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
  );
  return jsonResponse(request, document, {
    headers: {
      "Cache-Control": "no-store",
      ...(download && { "Content-Disposition": `attachment; filename="${OPENAPI_FILENAME}"` }),
    },
  });
}
