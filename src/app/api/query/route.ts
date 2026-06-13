import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, executeQuerySchema } from "@/lib/validation";
import { executeQuery } from "@/lib/query/query-engine";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { QueryDefinition } from "@/lib/query/types";

// Streaming, potentially long-running (Arr/Seerr sweeps + full-library eval).
// Force dynamic and cap the duration so a request can't pin a function forever.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, executeQuerySchema);
  if (error) return error;

  // Stream phase-by-phase progress, then the final result, as NDJSON so the
  // query builder can render a live progress bar instead of a blank spinner.
  // request.signal aborts the run (and frees the connection) on disconnect.
  return progressStreamResponse(
    (emit) =>
      executeQuery(
        data.query as QueryDefinition,
        session.userId!,
        data.page,
        data.limit,
        emit,
      ),
    { signal: request.signal },
  );
}
