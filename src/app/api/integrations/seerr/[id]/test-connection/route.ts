import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { validateRequest, arrTestConnectionSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { refuseStoredKeyToNewUrl } from "@/lib/integrations/stored-key-guard";

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

  const existing = await prisma.seerrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const refused = await refuseStoredKeyToNewUrl(session, existing.url, data.url, data.apiKey, "Seerr");
  if (refused) return refused;

  const testUrl = data.url ?? existing.url;
  const testKey = data.apiKey ?? existing.apiKey;
  const client = new SeerrClient(testUrl, testKey);
  const result = await client.testConnection();
  return NextResponse.json(
    result.ok ? result : { ...result, error: sanitizeErrorDetail(result.error) },
  );
}
