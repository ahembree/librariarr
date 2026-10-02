import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { openApiResponse } from "@/lib/api-keys/openapi-response";

// The OpenAPI document for the settings page's API docs viewer and Download
// button — cookie session only, like the rest of key management. The viewer
// gets a relative server URL so Try it out always uses the page's own scheme
// and host; a download keeps the absolute one (see `openApiResponse`). API
// clients read the same document from GET /api/v1/openapi.json with their key.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return openApiResponse(request, { relativeServer: true });
}
