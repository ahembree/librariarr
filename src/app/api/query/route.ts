import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, executeQuerySchema } from "@/lib/validation";
import { executeQuery } from "@/lib/query/execute";
import type { QueryDefinition } from "@/lib/query/types";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, executeQuerySchema);
  if (error) return error;

  const result = await executeQuery(
    data.query as QueryDefinition,
    session.userId!,
    data.page,
    data.limit,
  );

  return NextResponse.json(result);
}
