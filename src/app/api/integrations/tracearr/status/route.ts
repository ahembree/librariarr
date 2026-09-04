import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";
import { computeBackfillFraction } from "./backfill-fraction";

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
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only mapped servers have an import to report on; an unmapped server uses
  // its own native watch history and has no Tracearr state at all.
  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId!, tracearrServerId: { not: null } },
    select: {
      id: true,
      name: true,
      tracearrServerId: true,
      tracearrBackfillComplete: true,
      // The far edge of Tracearr's archive, measured once per server by
      // `findOldestPlayAt`. It is the denominator of the progress fraction —
      // read off the row we already fetch, so progress costs no extra query.
      tracearrOldestPlayAt: true,
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
  const aggregates = await prisma.watchHistory.groupBy({
    by: ["mediaServerId"],
    where: {
      mediaServerId: { in: servers.map((server) => server.id) },
      source: "TRACEARR",
    },
    _count: { _all: true },
    _min: { watchedAt: true },
    _max: { watchedAt: true },
  });

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

    return {
      serverId: server.id,
      serverName: server.name,
      tracearrServerId: server.tracearrServerId,
      backfillComplete: server.tracearrBackfillComplete,
      importedCount: aggregate?._count._all ?? 0,
      oldestImported: oldestImported?.toISOString() ?? null,
      newestImported: newestImported?.toISOString() ?? null,
      // Exposed alongside the fraction so the UI can say *where* the walk has
      // reached ("2019-07-21 → now") rather than only how far along it is, and
      // so a null fraction is explainable — an unmeasured edge looks the same as
      // an empty import from the fraction alone.
      oldestPlayAt: server.tracearrOldestPlayAt?.toISOString() ?? null,
      // 0..1, or null when progress is not yet knowable and the bar should be
      // indeterminate. The two are distinct states — see the helper for why the
      // denominator is a time span and not a count of records.
      backfillFraction: computeBackfillFraction({
        backfillComplete: server.tracearrBackfillComplete,
        oldestPlayAt: server.tracearrOldestPlayAt,
        oldestImported,
        newestImported,
      }),
    };
  });

  // No secrets reach this shape, but every integrations response goes through
  // sanitize() — keeping it here means a future field addition can't quietly
  // become the one uncovered leak on the surface.
  return NextResponse.json({ servers: sanitize(payload) });
}
