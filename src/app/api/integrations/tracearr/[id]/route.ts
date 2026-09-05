import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { validateRequest, tracearrInstanceUpdateSchema } from "@/lib/validation";
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

  const { data, error } = await validateRequest(request, tracearrInstanceUpdateSchema);
  if (error) return error;
  // `tracearrInstanceUpdateSchema` already maps a masked echo of the API key to
  // `undefined`, so an `apiKey` reaching here is always a real new key — both
  // the re-test below and the `...(apiKey && { apiKey })` write treat absence as
  // "keep the stored key".
  const { name, url, apiKey, enabled } = data;

  const existing = await prisma.tracearrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Test connection if credentials changed (skip if just toggling enabled)
  if ((url || apiKey) && enabled !== false) {
    const testUrl = url ?? existing.url;
    const testKey = apiKey ?? existing.apiKey;
    const client = new TracearrClient(testUrl, testKey);
    const result = await client.testConnection();
    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to connect", detail: sanitizeErrorDetail(result.error) },
        { status: 400 }
      );
    }
  }

  const instance = await prisma.tracearrInstance.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(url && { url: url.replace(/\/+$/, "") }),
      ...(apiKey && { apiKey }),
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

  const existing = await prisma.tracearrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.tracearrInstance.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
