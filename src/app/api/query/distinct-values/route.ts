import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { getDistinctValues } from "@/lib/media/distinct-values";

/**
 * Every value the Query builder's dropdowns offer: the library filter bar's
 * values without the slider ranges, Dynamic Range listed alphabetically.
 * Cached 5 minutes under its own key — see `src/lib/media/distinct-values.ts`,
 * shared with the library's route.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return jsonResponse(request, await getDistinctValues(session.userId!, "query"));
}
