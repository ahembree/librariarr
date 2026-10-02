import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { validateRequest, seerrInstanceUpdateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { invalidateSeerrCaches } from "@/lib/seerr/request-stats";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await validateRequest(request, seerrInstanceUpdateSchema);
  if (error) return error;
  const { name, url, apiKey, externalUrl, enabled } = data;

  const existing = await prisma.seerrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Test the connection only when it changes — a new URL or API key (skip if
  // just toggling enabled). The edit form sends its URL on every save, so
  // testing on its mere presence refused a rename or a new external URL
  // whenever the instance happened to be unreachable.
  const urlChanged = url !== undefined && url.replace(/\/+$/, "") !== existing.url;
  if ((urlChanged || apiKey) && enabled !== false) {
    const testUrl = url ?? existing.url;
    const testKey = apiKey ?? existing.apiKey;
    const client = new SeerrClient(testUrl, testKey);
    const result = await client.testConnection();
    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to connect", detail: sanitizeErrorDetail(result.error) },
        { status: 400 }
      );
    }
  }

  const instance = await prisma.seerrInstance.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(url && { url: url.replace(/\/+$/, "") }),
      ...(apiKey && { apiKey }),
      ...(externalUrl !== undefined && {
        externalUrl: externalUrl ? externalUrl.replace(/\/+$/, "") : null,
      }),
      ...(enabled !== undefined && { enabled }),
    },
  });
  invalidateSeerrCaches();

  return NextResponse.json({ instance: sanitize(instance) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.seerrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.seerrInstance.delete({ where: { id } });
  invalidateSeerrCaches();

  return NextResponse.json({ success: true });
}
