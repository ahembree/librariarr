import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { validateRequest, tracearrInstanceUpdateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { refuseStoredKeyToNewUrl } from "@/lib/integrations/stored-key-guard";
import { enqueueTracearrBackfill } from "@/lib/sync/tracearr-backfill-enqueue";

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

  const refused = await refuseStoredKeyToNewUrl(session, existing.url, url, apiKey, "Tracearr");
  if (refused) return refused;

  // Test the connection only when it changes — a new URL or API key (skip if
  // just toggling enabled). The edit form sends its URL on every save, so
  // testing on its mere presence refused a rename whenever Tracearr happened to
  // be unreachable — the same fix the Arr and Seerr routes carry.
  const urlChanged = url !== undefined && url.replace(/\/+$/, "") !== existing.url;
  if ((urlChanged || apiKey) && enabled !== false) {
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

  // Re-enabled, or pointed at a new address or key: whatever stopped the
  // import — every slice failing against the old address and parked ("History
  // import failing"), or no enabled instance at all — may be fixed now, so
  // queue a fresh slice for each mapped server instead of waiting for the next
  // watch-history sync. The keyed enqueue replaces a parked job with a fresh
  // one. A rename alone changes nothing the import depends on.
  const reenabled = enabled === true && !existing.enabled;
  if (instance.enabled && (reenabled || urlChanged || apiKey)) {
    await enqueueTracearrBackfill(
      { userId: session.userId! },
      reenabled ? "Tracearr instance re-enabled" : "Tracearr instance connection changed",
    );
  }

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
