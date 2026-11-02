import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { getRealtimeManager } from "@/lib/media-server/realtime";
import type { RealtimeConnectionStatus } from "@/lib/media-server/realtime/types";

export const dynamic = "force-dynamic";

/**
 * Live state of each enabled server's realtime WebSocket, for the indicator
 * under Settings → General → Real-time server sync. A proxy that drops the
 * WebSocket upgrade breaks real-time updates while every HTTP call (and so
 * every sync) still works, so without this nothing showed it.
 *
 * Every enabled server is listed, not only those the manager holds: one it has
 * not opened yet (the toggle was just switched on, or the server just added)
 * reads `connecting` — the manager reconciles on that change and every 60s.
 * Read-only and free of secrets.
 */
export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { realtimeSync: true },
  });
  const enabled = settings?.realtimeSync ?? true;
  if (!enabled) {
    return NextResponse.json({ enabled, servers: [] });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true, name: true, type: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const statusById = new Map(
    getRealtimeManager().getStatuses().map((entry) => [entry.serverId, entry.status]),
  );

  return NextResponse.json({
    enabled,
    servers: servers.map((server) => ({
      serverId: server.id,
      name: server.name,
      type: server.type,
      status: (statusById.get(server.id) ?? "connecting") satisfies RealtimeConnectionStatus,
    })),
  });
});
