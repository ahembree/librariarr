import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { openApiResponse } from "@/lib/api-keys/openapi-response";

// The OpenAPI document for the settings page's View / Download buttons —
// cookie session only, like the rest of key management. API clients read the
// same document from GET /api/v1/openapi.json with their key.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return openApiResponse(request);
}
