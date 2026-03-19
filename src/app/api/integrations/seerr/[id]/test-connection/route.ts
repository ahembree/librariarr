import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const existing = await prisma.seerrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const testUrl = body.url ?? existing.url;
  const testKey = body.apiKey ?? existing.apiKey;
  const client = new SeerrClient(testUrl, testKey);
  const result = await client.testConnection();
  return NextResponse.json(result);
}
