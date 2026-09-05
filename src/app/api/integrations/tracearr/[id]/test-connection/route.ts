import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { validateRequest, arrTestConnectionSchema } from "@/lib/validation";
import { MASKED_VALUE } from "@/lib/api/sanitize";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, arrTestConnectionSchema);
  if (error) return error;

  const existing = await prisma.tracearrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const testUrl = data.url ?? existing.url;
  // The settings form renders the stored key masked and echoes whatever it holds
  // back, so a re-test of an untouched instance arrives carrying `MASKED_VALUE`.
  // Testing that literal would always fail; fall back to the stored key exactly
  // as an omitted field does (same idiom as `/api/settings/ai/test`).
  const testKey =
    data.apiKey === undefined || data.apiKey === MASKED_VALUE ? existing.apiKey : data.apiKey;
  const client = new TracearrClient(testUrl, testKey);
  const result = await client.testConnection();
  return NextResponse.json(result);
}
