import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";
import {
  computeBackfillFraction,
  importPausedReason,
  importPending,
  resolveBackfillReach,
} from "./backfill-fraction";
import {
  getTracearrBackfillReach,
  getTracearrImportActivity,
} from "@/lib/sync/tracearr-import-activity";

/** The state of each server's `tracearr-backfill:<serverId>` job. */
interface BackfillJobState {
  /** Waiting, running or backing off — will run again by itself. */
  queued: Set<string>;
  /** Used up its attempts: graphile keeps the row but never runs it again. */
  parked: Set<string>;
  /** The table was read — without it, "no job" is unknown, not known. */
  known: boolean;
}

/**
 * Servers with a backfill slice queued, running or backing off, and those
 * whose slice is parked — read from the job queue's own table, under the jobKey
 * `tracearr-backfill:<serverId>` that both enqueue sites share. Best-effort: on
 * a failed read (no `graphile_worker` schema yet) `known` is false, and every
 * server is judged on its stored evidence instead — never reported as failing,
 * nor as waiting for a sync.
 */
async function backfillJobStates(serverIds: string[]): Promise<BackfillJobState> {
  const state: BackfillJobState = { queued: new Set(), parked: new Set(), known: false };
  try {
    const rows = await prisma.$queryRawUnsafe<{ key: string; parked: boolean }[]>(
      // `locked_at IS NULL`: graphile counts an attempt when it takes the job,
      // so a slice running its LAST attempt already reads attempts = max.
      `SELECT "key", ("attempts" >= "max_attempts" AND "locked_at" IS NULL) AS "parked"
         FROM graphile_worker.jobs
        WHERE "key" = ANY($1::text[])`,
      serverIds.map((id) => `tracearr-backfill:${id}`),
    );
    for (const row of rows) {
      const serverId = row.key.slice("tracearr-backfill:".length);
      (row.parked ? state.parked : state.queued).add(serverId);
    }
    state.known = true;
  } catch {
    // See above: unknown reads as "no job".
  }
  return state;
}

/**
 * GET /api/integrations/tracearr/status
 *
 * Per-server progress of the Tracearr history import: how much has landed, the
 * span it covers, and whether the one-time backwards walk is finished.
 *
 * The backfill runs on the job queue in 5-minute slices that re-enqueue
 * themselves (`TASK_TRACEARR_BACKFILL`), so the only way the UI can show a
 * 160k-play archive filling in is to poll something. This is that something —
 * which is exactly why the aggregate below is ONE grouped query rather than one
 * per server: `WatchHistory` reaches hundreds of thousands of rows on the very
 * servers whose status is worth watching, and a poll loop that fans out a
 * COUNT/MIN/MAX per mapped server multiplies that scan by the server count on
 * every tick.
 *
 * `backfillFraction` turns that state into a determinate 0..1 bar; it is `null`
 * when progress cannot be known yet, which the UI must render as indeterminate
 * rather than as 0. See `./backfill-fraction` for the arithmetic and, more
 * importantly, for why it measures time coverage instead of imported records.
 *
 * `pending` is the answer to "should anything wait on this server's import" —
 * see `importPending` in `./backfill-fraction`. It is NOT `!backfillComplete`: that flag stays
 * false forever on a disabled server, behind a disabled Tracearr instance, and
 * on a mapping Tracearr holds no plays for, and every reader that waited on it
 * (a spinner, the History page's poll) waited forever.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only mapped servers have an import to report on; an unmapped server uses
  // its own native watch history and has no Tracearr state at all. Disabled
  // servers stay in the list — Settings renders a line under every server and
  // a vanished line would read as "unmapped" — but are never `pending`.
  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId!, tracearrServerId: { not: null } },
    select: {
      id: true,
      name: true,
      enabled: true,
      tracearrServerId: true,
      tracearrBackfillComplete: true,
      // The far edge of Tracearr's archive, measured once per server by
      // `findOldestPlayAt`. It is the denominator of the progress fraction —
      // read off the row we already fetch, so progress costs no extra query.
      tracearrOldestPlayAt: true,
      tracearrBackfillCursorAt: true,
      tracearrBackfillLastWalkAt: true,
      tracearrBackfillRestartedAt: true,
    },
    // Total order: the UI polls this repeatedly and re-renders the list, so ties
    // on `name` must not permute between requests.
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });

  if (servers.length === 0) {
    return NextResponse.json({ servers: [] });
  }

  // One pass over the imported rows for every mapped server, joined back in
  // memory below. `source: "TRACEARR"` is load-bearing: a server that was mapped
  // partway through its life still holds NATIVE rows from before the switch, and
  // counting those would report progress the importer never made.
  const [aggregates, enabledInstances, backfillJobs, populatedServers] = await Promise.all([
    prisma.watchHistory.groupBy({
      by: ["mediaServerId"],
      where: {
        mediaServerId: { in: servers.map((server) => server.id) },
        source: "TRACEARR",
      },
      _count: { _all: true },
      _min: { watchedAt: true },
      _max: { watchedAt: true },
    }),
    prisma.tracearrInstance.count({ where: { userId: session.userId!, enabled: true } }),
    backfillJobStates(servers.map((server) => server.id)),
    // Servers with an item in an ENABLED library: the importer walks nothing
    // into a server without one (no play could be attributed), and a server
    // whose libraries are all disabled gets none from any sync — so "starts
    // with the next sync" would be untrue there. One semi-join per call.
    prisma.mediaServer.findMany({
      where: {
        id: { in: servers.map((server) => server.id) },
        libraries: { some: { enabled: true, mediaItems: { some: {} } } },
      },
      select: { id: true },
    }),
  ]);
  const hasLibraryItems = new Set(populatedServers.map((server) => server.id));

  const byServerId = new Map(
    aggregates.map((aggregate) => [aggregate.mediaServerId, aggregate])
  );

  const payload = servers.map((server) => {
    // A `groupBy` emits no row for a server with nothing imported, and "mapped
    // but nothing imported yet" is a real state the UI has to render (it is what
    // every mapping looks like until the first forward pass lands), so the
    // missing group becomes an explicit zero rather than an omitted server.
    const aggregate = byServerId.get(server.id);

    // `watchedAt` is nullable, so MIN/MAX can be null even with rows present.
    const oldestImported = aggregate?._min.watchedAt ?? null;
    const newestImported = aggregate?._max.watchedAt ?? null;
    const importedCount = aggregate?._count._all ?? 0;

    // The import running for this server right now, if any — live this-run
    // counters the stored rows cannot express. `null` when nothing is running.
    const activeImport = getTracearrImportActivity(server.id);
    // How far a live BACKFILL walk has reached — never a forward pass's (it
    // walks the newest hour, which says nothing about how far back the archive
    // is covered), whichever run is newest, and never a run superseded by a
    // purge restart or a mapping change: that run is still paging the OLD
    // archive position, and its deep reach would win "older wins" below over
    // the cursor the restart just moved to now.
    const liveReachIso = getTracearrBackfillReach(server.id);
    const liveReached = liveReachIso ? new Date(liveReachIso) : null;
    const cursorAt = server.tracearrBackfillCursorAt;
    const reachedAt = resolveBackfillReach({ oldestImported, cursorAt, liveReached });

    const running = activeImport !== null;
    const queued = backfillJobs.queued.has(server.id);
    // Parked AND nothing live: a run in progress (a History-page Refresh, a
    // slice re-queued since the read) is progress, whatever the old row says.
    const failing = backfillJobs.parked.has(server.id) && !running && !queued;
    const importState = {
      backfillComplete: server.tracearrBackfillComplete,
      importedCount,
      oldestPlayAt: server.tracearrOldestPlayAt,
      cursorAt,
      lastWalkAt: server.tracearrBackfillLastWalkAt,
      restartedAt: server.tracearrBackfillRestartedAt,
      running,
      queued,
      jobsKnown: backfillJobs.known,
    };
    const pausedReason = importPausedReason({
      ...importState,
      serverEnabled: server.enabled,
      instanceEnabled: enabledInstances > 0,
      hasLibraryItems: hasLibraryItems.has(server.id),
      failing,
    });

    return {
      serverId: server.id,
      serverName: server.name,
      tracearrServerId: server.tracearrServerId,
      backfillComplete: server.tracearrBackfillComplete,
      importedCount,
      oldestImported: oldestImported?.toISOString() ?? null,
      newestImported: newestImported?.toISOString() ?? null,
      // Exposed alongside the fraction so the UI can say *where* the walk has
      // reached ("2019-07-21 → now") rather than only how far along it is, and
      // so a null fraction is explainable — an unmeasured edge looks the same as
      // an empty import from the fraction alone.
      oldestPlayAt: server.tracearrOldestPlayAt?.toISOString() ?? null,
      // The point the fraction below is measured from — what a "reached
      // <date>" line must name. Not `oldestImported`: after a purge restarts
      // the walk the surviving rows still reach the far end while the walk
      // starts again from now, and the two side by side read "0% … reached
      // 2019".
      reachedAt: reachedAt?.toISOString() ?? null,
      // 0..1, or null when progress is not yet knowable and the bar should be
      // indeterminate. The two are distinct states — see the helper for why the
      // denominator is a time span and not a count of records.
      backfillFraction: computeBackfillFraction({
        backfillComplete: server.tracearrBackfillComplete,
        oldestPlayAt: server.tracearrOldestPlayAt,
        oldestImported,
        newestImported,
        cursorAt,
        liveReached,
      }),
      // Whether anything should wait on this import — see `importPending`.
      pending: importPending({ ...importState, pausedReason }),
      pausedReason,
      // When a backfill walk last ran for this mapping, or null if none has
      // yet — what separates "waiting for the first import" from "walked and
      // Tracearr had no plays for it".
      lastWalkAt: server.tracearrBackfillLastWalkAt?.toISOString() ?? null,
      activeImport,
    };
  });

  // No secrets reach this shape, but every integrations response goes through
  // sanitize() — keeping it here means a future field addition can't quietly
  // become the one uncovered leak on the surface.
  return NextResponse.json({ servers: sanitize(payload) });
}
