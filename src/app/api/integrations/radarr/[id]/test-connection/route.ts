import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { validateRequest, arrTestConnectionSchema } from "@/lib/validation";

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

  const existing = await prisma.radarrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const testUrl = data.url ?? existing.url;
  const testKey = data.apiKey ?? existing.apiKey;
  const client = new RadarrClient(testUrl, testKey);
  const result = await client.testConnection();
  return NextResponse.json(result);
}
