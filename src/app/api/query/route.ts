import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, executeQuerySchema } from "@/lib/validation";
import { executeQuery } from "@/lib/query/query-engine";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { QueryDefinition } from "@/lib/query/types";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, executeQuerySchema);
  if (error) return error;

  // Stream phase-by-phase progress, then the final result, as NDJSON so the
  // query builder can render a live progress bar instead of a blank spinner.
  return progressStreamResponse((emit) =>
    executeQuery(
      data.query as QueryDefinition,
      session.userId!,
      data.page,
      data.limit,
      emit,
    ),
  );
}
