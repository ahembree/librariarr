import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, watchHistorySyncSchema } from "@/lib/validation";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { appCache } from "@/lib/cache/memory-cache";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, watchHistorySyncSchema);
  if (error) return error;

  const counts: Record<string, number> = {};

  if (data.serverId) {
    // Validate ownership
    const server = await prisma.mediaServer.findFirst({
      where: { id: data.serverId, userId: session.userId },
      select: { id: true },
    });
    if (!server) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }

    const result = await syncWatchHistory(data.serverId);
    counts[data.serverId] = result.count;
  } else {
    // Sync all enabled servers for this user
    const servers = await prisma.mediaServer.findMany({
      where: { userId: session.userId, enabled: true },
      select: { id: true },
    });

    for (const server of servers) {
      try {
        const result = await syncWatchHistory(server.id);
        counts[server.id] = result.count;
      } catch {
        counts[server.id] = -1;
      }
    }
  }

  // Invalidate cached filter dropdown values
  appCache.invalidatePrefix("watch-history-filters:");

  return NextResponse.json({ success: true, counts });
}
