import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getRealtimeManager } from "@/lib/media-server/realtime";

export const dynamic = "force-dynamic";

/**
 * Live status of the media-server realtime WebSocket connections: whether the
 * feature is enabled and the current connection state per server. Read-only,
 * no secrets — safe to return unsanitized.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { realtimeSync: true },
  });
  const enabled = settings?.realtimeSync ?? true;

  const servers = getRealtimeManager().getStatuses();

  return NextResponse.json({ enabled, servers });
}
