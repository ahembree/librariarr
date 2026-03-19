import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { validateRequest, syncByTypeSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, syncByTypeSchema);
  if (error) return error;

  const { libraryType } = data;

  // Find all enabled servers with enabled libraries of the requested type
  const servers = await prisma.mediaServer.findMany({
    where: {
      userId: session.userId,
      enabled: true,
      libraries: {
        some: { type: libraryType, enabled: true },
      },
    },
    include: {
      libraries: {
        where: { type: libraryType, enabled: true },
        select: { key: true },
      },
      syncJobs: {
        where: { status: { in: ["RUNNING", "PENDING"] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  let syncedCount = 0;
  let skippedCount = 0;

  for (const server of servers) {
    if (server.syncJobs.length > 0) {
      skippedCount++;
      continue;
    }

    for (const library of server.libraries) {
      syncMediaServer(server.id, library.key, { skipWatchHistory: true }).catch((err) =>
        logger.error("Sync", `Sync failed for ${server.name}`, { error: String(err) })
      );
    }
    syncedCount++;
  }

  return NextResponse.json({
    message: syncedCount > 0 ? "Sync started" : "No servers available to sync",
    syncedCount,
    skippedCount,
  });
}
