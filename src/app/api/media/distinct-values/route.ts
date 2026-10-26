import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { getDistinctValues } from "@/lib/media/distinct-values";

/**
 * Every value the library filter bar offers, with the numeric and date ranges
 * its sliders read. Cached 5 minutes (it only changes on a sync, which drops
 * it), computed once however many requests miss together — see
 * `src/lib/media/distinct-values.ts`, shared with the Query builder's route.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return jsonResponse(request, await getDistinctValues(session.userId!, "library"));
}
