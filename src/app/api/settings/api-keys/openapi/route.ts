import { NextRequest } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { openApiResponse } from "@/lib/api-keys/openapi-response";

// The OpenAPI document for the settings page's API docs viewer and Download
// button — cookie session only, like the rest of key management. The viewer
// gets a relative server URL so Try it out always uses the page's own scheme
// and host; a download keeps the absolute one (see `openApiResponse`). API
// clients read the same document from GET /api/v1/openapi.json with their key.
export const GET = withSession(async (session, request: NextRequest) => {
  return openApiResponse(request, { relativeServer: true });
});
