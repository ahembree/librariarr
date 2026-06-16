import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TautulliClient } from "@/lib/tautulli/client";
import { validateRequest, tautulliInstanceUpdateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await validateRequest(request, tautulliInstanceUpdateSchema);
  if (error) return error;
  const { name, url, apiKey, mediaServerId, enabled } = data;

  const existing = await prisma.tautulliInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (mediaServerId) {
    const server = await prisma.mediaServer.findFirst({
      where: { id: mediaServerId, userId: session.userId! },
    });
    if (!server) {
      return NextResponse.json({ error: "Media server not found" }, { status: 404 });
    }
  }

  // Test connection if credentials changed (skip if just toggling enabled).
  if ((url || apiKey) && enabled !== false) {
    const testUrl = url ?? existing.url;
    const testKey = apiKey ?? existing.apiKey;
    const client = new TautulliClient(testUrl, testKey);
    const result = await client.testConnection();
    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to connect to Tautulli", detail: sanitizeErrorDetail(result.error) },
        { status: 400 }
      );
    }
  }

  const instance = await prisma.tautulliInstance.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(url && { url: url.replace(/\/+$/, "") }),
      ...(apiKey && { apiKey }),
      ...(mediaServerId !== undefined && { mediaServerId: mediaServerId || null }),
      ...(enabled !== undefined && { enabled }),
    },
  });

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

  const existing = await prisma.tautulliInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.tautulliInstance.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
