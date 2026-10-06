import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";
import { computeBackfillFraction, resolveBackfillReach } from "./backfill-fraction";
import { getTracearrImportActivity } from "@/lib/sync/tracearr-import-activity";

/** Why an owed import cannot progress right now, when that is the case. */
type ImportPausedReason = "server-disabled" | "instance-unavailable";

/**
 * Whether this server's archive import is genuinely still owed AND will make
 * progress — the signal a spinner or a poll may wait on.
 *
 * Not owed: `backfillComplete`. Cannot progress: the server is disabled (no
 * sync of any kind runs for it) or the user has no enabled Tracearr instance
 * (`syncWatchHistory` then skips a mapped server outright rather than falling
 * back to native). Both are reported with `pausedReason` so Settings can say
 * why instead of spinning. With several instances, which one owns the mapping
 * is only knowable by asking each over the network, which a polled route must
 * not do — "at least one enabled" is the approximation, and an unowned mapping
 * then behaves like the next case.
 *
 * The subtle case is a mapping Tracearr holds no plays for (a wrong mapping, a
 * freshly installed Tracearr). Its walk comes back exhausted with zero records,
 * which deliberately does NOT mark the backfill complete and does not
 * re-enqueue the slice — so it would read "importing" forever. Nothing is
 * persisted for it, so it is recognised by what it leaves: no imported rows,
 * no measured far edge (`findOldestPlayAt` found nothing to store), no walk
 * cursor, no run in progress and no backfill job waiting. Every import that
 * WILL progress has at least one of those: a slice running (`activeImport`) or
 * queued (the job), or evidence from an earlier one that there is history to
 * walk. A brand-new mapping looks the same until its first sync queues a slice
 * — correctly not pending either: nothing is going to happen until that sync,
 * and the moment one queues the slice it reads pending again.
 */
function importPending(input: {
  pausedReason: ImportPausedReason | null;
  backfillComplete: boolean;
  importedCount: number;
  oldestPlayAt: Date | null;
  cursorAt: Date | null;
  running: boolean;
  queued: boolean;
}): boolean {
  if (input.pausedReason !== null || input.backfillComplete) return false;
  return (
    input.running ||
    input.queued ||
    input.importedCount > 0 ||
    input.oldestPlayAt !== null ||
    input.cursorAt !== null
  );
}

/**
 * Servers with a backfill slice queued, running or backing off — read from the
 * job queue's own table, under the jobKey `tracearr-backfill:<serverId>` that
 * both enqueue sites share. A job that used up its attempts is parked, not
 * waiting, so it does not count. Best-effort: on a failed read (no
 * `graphile_worker` schema yet) every server reads as having nothing queued,
 * which only ever withholds `pending` from an import with no other evidence.
 */
async function serversWithQueuedBackfill(serverIds: string[]): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ key: string }[]>(
      `SELECT "key" FROM graphile_worker.jobs
        WHERE "key" = ANY($1::text[]) AND "attempts" < "max_attempts"`,
      serverIds.map((id) => `tracearr-backfill:${id}`),
    );
    return new Set(rows.map((row) => row.key.slice("tracearr-backfill:".length)));
  } catch {
    return new Set();
  }
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
 * see `importPending` above. It is NOT `!backfillComplete`: that flag stays
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
  const [aggregates, enabledInstances, queuedBackfill] = await Promise.all([
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
    serversWithQueuedBackfill(servers.map((server) => server.id)),
  ]);

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
    // Only the backfill pass's reach says how far back the archive is covered;
    // `backfillReached` is never written by the forward pass.
    const liveReached = activeImport?.backfillReached
      ? new Date(activeImport.backfillReached)
      : null;
    const cursorAt = server.tracearrBackfillCursorAt;
    const reachedAt = resolveBackfillReach({ oldestImported, cursorAt, liveReached });

    const pausedReason: ImportPausedReason | null = !server.enabled
      ? "server-disabled"
      : enabledInstances === 0
        ? "instance-unavailable"
        : null;

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
      pending: importPending({
        pausedReason,
        backfillComplete: server.tracearrBackfillComplete,
        importedCount,
        oldestPlayAt: server.tracearrOldestPlayAt,
        cursorAt,
        running: activeImport !== null,
        queued: queuedBackfill.has(server.id),
      }),
      pausedReason,
      activeImport,
    };
  });

  // No secrets reach this shape, but every integrations response goes through
  // sanitize() — keeping it here means a future field addition can't quietly
  // become the one uncovered leak on the surface.
  return NextResponse.json({ servers: sanitize(payload) });
}
