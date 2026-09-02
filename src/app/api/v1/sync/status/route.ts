import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";

/**
 * Current sync state, one entry per server.
 *
 * Deliberately not paginated: the shape is one row per configured media server
 * (a handful at most), and an integration polling this wants the whole picture
 * in one call rather than a cursor.
 *
 * The internal route returns raw SyncJob rows; this pivots them onto the server
 * so a caller can answer "is server X syncing, and how did it last go" without
 * reassembling the join itself.
 */
export const GET = withApiKey(async (_request, { userId }) => {
  const servers = await prisma.mediaServer.findMany({
    where: { userId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, type: true, enabled: true },
  });

  if (servers.length === 0) {
    return NextResponse.json({ servers: [] });
  }

  const serverIds = servers.map((s) => s.id);

  const activeJobs = await prisma.syncJob.findMany({
    where: { mediaServerId: { in: serverIds }, status: { in: ["RUNNING", "PENDING"] } },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      mediaServerId: true,
      status: true,
      startedAt: true,
      currentLibrary: true,
      itemsProcessed: true,
      totalItems: true,
    },
  });

  // One findFirst per server rather than a window function: the server count is
  // in the single digits, so this stays cheaper than pulling a page of history
  // and picking the newest row per server in memory.
  const lastFinished = await Promise.all(
    serverIds.map((id) =>
      prisma.syncJob.findFirst({
        where: { mediaServerId: id, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
        orderBy: [{ startedAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          error: true,
          itemsProcessed: true,
          totalItems: true,
        },
      }),
    ),
  );

  const items = servers.map((server, index) => {
    // Newest first, so the first active job is the one to report.
    const current = activeJobs.find((job) => job.mediaServerId === server.id) ?? null;
    return {
      id: server.id,
      name: server.name,
      type: server.type,
      enabled: server.enabled,
      status: current?.status ?? "IDLE",
      current: current
        ? {
            id: current.id,
            status: current.status,
            startedAt: current.startedAt,
            currentLibrary: current.currentLibrary,
            itemsProcessed: current.itemsProcessed,
            totalItems: current.totalItems,
          }
        : null,
      lastSync: lastFinished[index],
    };
  });

  // No token is selected above; sanitize() is the backstop for the day someone
  // widens the select list.
  return NextResponse.json({ servers: sanitize(items) });
});
