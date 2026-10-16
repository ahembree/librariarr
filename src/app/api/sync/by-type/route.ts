import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { enqueueJob, queuedSyncJobIds } from "@/lib/jobs/client";
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
    // Each library job's row exists from the moment the sync is asked for,
    // exactly as in `/api/servers/[id]/sync`: MAIN_QUEUE is serial, so these
    // jobs can wait behind a Tracearr backfill slice, another server's sync or
    // a lifecycle run, and with no row until the worker reached them the
    // library page's Sync button saw no RUNNING/PENDING job on its first poll
    // and reported the sync finished while it had not started.
    //
    // One row per library job, each carried in its own payload and claimed by
    // that job (see `claimSyncJob`). A row shared by the server's library jobs
    // was claimed by the first and completed with it, so the button stopped
    // spinning between libraries — before a Series request that had joined a
    // queued Movies row synced anything at all — and a Stop pressed then could
    // not reach the libraries still queued. Now a queued row is PENDING until
    // its own job runs, and Stop ends every PENDING row.
    //
    // A row is reused only for the job it already belongs to: a keyed enqueue
    // replaces a still-queued job's payload, so a repeated request for the same
    // library carries that job's row on rather than leaving it PENDING with
    // nothing to claim it.
    //
    // Created under the same per-server lock as the per-server route. Neither a
    // queued nor a RUNNING sync makes the server skip: the jobs queue behind it
    // (MAIN_QUEUE is serial, and the sync task's guard counts RUNNING rows
    // only, so by the time they start the running one has finished).
    const jobKeyOf = (libraryKey: string) => `sync:${server.id}:${libraryKey}`;
    const libraryRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('sync-request:' || $1))`,
        server.id,
      );
      const queuedRows = await queuedSyncJobIds(server.libraries.map((library) => jobKeyOf(library.key)));
      const stillPending = new Set(
        (
          await tx.syncJob.findMany({
            where: { id: { in: [...(queuedRows?.values() ?? [])] }, status: "PENDING" },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const rows: { libraryKey: string; id: string; created: boolean }[] = [];
      for (const library of server.libraries) {
        const queuedId = queuedRows?.get(jobKeyOf(library.key));
        if (queuedId && stillPending.has(queuedId)) {
          rows.push({ libraryKey: library.key, id: queuedId, created: false });
          continue;
        }
        const row = await tx.syncJob.create({
          data: { mediaServerId: server.id, status: "PENDING", startedAt: new Date() },
          select: { id: true },
        });
        rows.push({ libraryKey: library.key, id: row.id, created: true });
      }
      return rows;
    });

    let queued = false;
    for (const row of libraryRows) {
      const enqueued = await enqueueJob(
        TASK_SYNC_SERVER,
        {
          serverId: server.id,
          libraryKey: row.libraryKey,
          skipWatchHistory: true,
          trigger: `manual sync of every ${libraryType} library`,
          syncJobId: row.id,
        },
        // Someone is waiting on this sync, so it goes ahead of queued
        // background work, as a sync requested from Settings does.
        {
          jobKey: jobKeyOf(row.libraryKey),
          queueName: MAIN_QUEUE,
          maxAttempts: 3,
          priority: REQUESTED_SYNC_PRIORITY,
        },
      );
      if (enqueued) {
        queued = true;
      } else if (row.created) {
        // Nothing will ever claim the row, and a PENDING row makes every sync
        // route answer as though a sync were already queued — close it here. A
        // reused row still belongs to the job already queued under the key.
        await prisma.syncJob.update({
          where: { id: row.id },
          data: { status: "FAILED", completedAt: new Date(), error: "Could not queue the sync job" },
        });
      }
    }
    if (!queued) {
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
