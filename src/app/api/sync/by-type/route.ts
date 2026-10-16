import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { eventBus } from "@/lib/events/event-bus";
import {
  MAIN_QUEUE,
  REQUESTED_SYNC_PRIORITY,
  TASK_SYNC_SERVER,
  TASK_SYNC_WATCH_HISTORY,
} from "@/lib/jobs/constants";
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
    },
  });

  let syncedCount = 0;
  let skippedCount = 0;

  for (const server of servers) {
    // The row exists from the moment the sync is asked for, exactly as in
    // `/api/servers/[id]/sync`: MAIN_QUEUE is serial, so these jobs can wait
    // behind a Tracearr backfill slice, another server's sync or a lifecycle
    // run, and with no row until the worker reached them the library page's
    // Sync button saw no RUNNING/PENDING job on its first poll and reported the
    // sync finished while it had not started. One row per server, shared by
    // its library jobs: the first job claims it, the rest claim their own when
    // they run (see `claimSyncJob`), and a Stop on the queued row cancels every
    // one of them — they all carry its id and skip on CANCELLED.
    //
    // Checked and created under the same per-server lock as the per-server
    // route, so the two cannot each create a row for one server.
    const syncJob = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('sync-request:' || $1))`,
        server.id,
      );
      const activeJob = await tx.syncJob.findFirst({
        where: { mediaServerId: server.id, status: { in: ["RUNNING", "PENDING"] } },
        select: { id: true },
      });
      if (activeJob) return null;
      return tx.syncJob.create({
        data: { mediaServerId: server.id, status: "PENDING", startedAt: new Date() },
        select: { id: true },
      });
    });
    if (!syncJob) {
      skippedCount++;
      continue;
    }

    let queued = false;
    for (const library of server.libraries) {
      const enqueued = await enqueueJob(
        TASK_SYNC_SERVER,
        {
          serverId: server.id,
          libraryKey: library.key,
          skipWatchHistory: true,
          trigger: `manual sync of every ${libraryType} library`,
          syncJobId: syncJob.id,
        },
        // Someone is waiting on this sync, so it goes ahead of queued
        // background work, as a sync requested from Settings does.
        {
          jobKey: `sync:${server.id}:${library.key}`,
          queueName: MAIN_QUEUE,
          maxAttempts: 3,
          priority: REQUESTED_SYNC_PRIORITY,
        },
      );
      if (enqueued) queued = true;
    }
    if (!queued) {
      // Nothing will ever claim the row, and a PENDING row makes every sync
      // route answer as though a sync were already queued — close it here.
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: { status: "FAILED", completedAt: new Date(), error: "Could not queue the sync job" },
      });
      skippedCount++;
      continue;
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
    // MAIN_QUEUE is serial and ordered by priority, then enqueue time, so this
    // (default priority) runs *after* every library job for the server has
    // finished — meaning their `SyncJob` rows are COMPLETED and
    // `syncWatchHistoryTask`'s "a full sync is already running" guard does not
    // swallow it. Sharing the realtime manager's jobKey dedupes with any
    // refresh a `watch-changed` event already queued.
    await enqueueJob(
      TASK_SYNC_WATCH_HISTORY,
      { serverId: server.id },
      { jobKey: `watch-history:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );

    eventBus.emit({ type: "sync:started", userId: session.userId!, meta: { serverId: server.id } });
    syncedCount++;
  }

  return NextResponse.json({
    message: syncedCount > 0 ? "Sync started" : "No servers available to sync",
    syncedCount,
    skippedCount,
  });
}
