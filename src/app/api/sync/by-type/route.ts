import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY } from "@/lib/jobs/constants";
import { validateRequest, syncByTypeSchema } from "@/lib/validation";

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
      await enqueueJob(
        TASK_SYNC_SERVER,
        {
          serverId: server.id,
          libraryKey: library.key,
          skipWatchHistory: true,
          trigger: `manual sync of every ${libraryType} library`,
        },
        { jobKey: `sync:${server.id}:${library.key}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
      );
    }

    // The per-library jobs above skip the watch-history scan (it is server-wide,
    // so running it once per library would repeat the same work N times), which
    // leaves them writing `MediaItem.playCount`/`lastPlayedAt` from
    // *account-scoped* item metadata only — the admin token's own views on Plex,
    // and nothing at all on Jellyfin/Emby (`getWatchCounts()` returns an empty
    // map by design). Without the follow-up refresh below, a library synced from
    // this route reports the owner's last play instead of the household's most
    // recent one everywhere those columns are read: the hover card, the Last
    // Played column, and the `Series Last Played` rule/query criterion.
    //
    // MAIN_QUEUE is serial and ordered by enqueue time, so this runs *after*
    // every library job for the server has finished — meaning their `SyncJob`
    // rows are COMPLETED and `syncWatchHistoryTask`'s "a full sync is already
    // running" guard does not swallow it. Sharing the realtime manager's jobKey
    // dedupes with any refresh a `watch-changed` event already queued.
    await enqueueJob(
      TASK_SYNC_WATCH_HISTORY,
      { serverId: server.id },
      { jobKey: `watch-history:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );

    syncedCount++;
  }

  return NextResponse.json({
    message: syncedCount > 0 ? "Sync started" : "No servers available to sync",
    syncedCount,
    skippedCount,
  });
}
