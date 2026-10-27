import { NextRequest } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { jsonResponse } from "@/lib/api/json-response";
import { getDistinctValues } from "@/lib/media/distinct-values";

/**
 * Every value the Query builder's dropdowns offer: the library filter bar's
 * values without the slider ranges, Dynamic Range listed alphabetically.
 * Cached 5 minutes under its own key — see `src/lib/media/distinct-values.ts`,
 * shared with the library's route.
 */
export const GET = withSession(async (session, request: NextRequest) => {
  return jsonResponse(request, await getDistinctValues(session.userId, "query"));
});
