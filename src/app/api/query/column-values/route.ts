import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, queryColumnValuesSchema } from "@/lib/validation";
import { computeQueryColumnValues } from "@/lib/query/column-values";
import { jsonResponse } from "@/lib/api/json-response";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { apiLogger } from "@/lib/logger";

// May fetch a whole Arr/Seerr catalogue for the Arr/Seerr columns.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Values of the Query page's criterion columns for the result rows on screen.
 * Read-only; scoped to the caller's enabled servers (and the query's server
 * selection), so an id from anywhere else simply returns nothing.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, queryColumnValuesSchema);
  if (error) return error;

  try {
    const result = await computeQueryColumnValues(session.userId!, data);
    return jsonResponse(request, result);
  } catch (err) {
    apiLogger.error("Query", "Failed to compute query column values", { error: String(err) });
    return NextResponse.json(
      { error: "Failed to load column values", detail: sanitizeErrorDetail(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
