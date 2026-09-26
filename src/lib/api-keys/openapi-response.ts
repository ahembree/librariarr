import { NextResponse, type NextRequest } from "next/server";
import { getExternalBaseUrl } from "@/lib/url";
import { buildOpenApiDocument } from "./openapi";

export const OPENAPI_FILENAME = "librariarr-openapi.json";

/**
 * The OpenAPI document as a response, built for THIS request: the `servers`
 * URL is the address the request arrived on, and the version is the running
 * app's. Nothing is stored on disk, so it cannot go stale. `?download=1` hands
 * the browser a file instead of a page.
 */
export function openApiResponse(request: NextRequest): Response {
  const document = buildOpenApiDocument(
    getExternalBaseUrl(request),
    process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
  );
  const download = request.nextUrl.searchParams.get("download") === "1";
  return NextResponse.json(document, {
    headers: {
      "Cache-Control": "no-store",
      ...(download && { "Content-Disposition": `attachment; filename="${OPENAPI_FILENAME}"` }),
    },
  });
}
