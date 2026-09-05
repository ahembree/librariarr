import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, watchHistorySyncSchema } from "@/lib/validation";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import type { WatchHistoryProgress } from "@/lib/sync/watch-history-progress";
import { appCache } from "@/lib/cache/memory-cache";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressPhase } from "@/lib/progress/types";

// Streaming and genuinely long-running: this is the one sync a user waits on in
// the foreground (the History page's Refresh button), and a first Tracearr
// import walks a server's entire history one keyset page at a time.
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

// `progressStreamResponse` defaults to a 10-minute lifetime cap, which a
// first-run Tracearr import of a large history routinely blows past — the cap
// would abort precisely the sync that most needs a progress bar. 30 minutes is
// generous enough for that first import while still bounding a wedged
// connection.
//
// Being aborted is survivable in both provenances, which is why a cap at all is
// acceptable: the Tracearr importer appends/upserts and advances its watermark
// as it goes, so the next run resumes from where this one stopped; the native
// path's full replace runs inside a single transaction, so an abort rolls back
// to the previous consistent state rather than leaving a half-wiped table.
const MAX_SYNC_LIFETIME_MS = 30 * 60 * 1000;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, watchHistorySyncSchema);
  if (error) return error;

  // Resolve the work BEFORE opening the stream. Auth, validation and the
  // ownership check are the only failures that can still carry a real HTTP
  // status — the moment the first NDJSON byte is written the status is
  // committed to 200 and every later error is in-band (the established pattern
  // in `progressStreamResponse`). Resolving up front also yields the server
  // names the plan needs, so the UI can name every phase before any work runs.
  let servers: { id: string; name: string }[];

  if (data.serverId) {
    // Validate ownership
    const server = await prisma.mediaServer.findFirst({
      where: { id: data.serverId, userId: session.userId },
      select: { id: true, name: true },
    });
    if (!server) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    servers = [server];
  } else {
    // Sync all enabled servers for this user. Ordered by name so the phase
    // list the user sees is stable across runs rather than in whatever order
    // Postgres happens to return rows.
    servers = await prisma.mediaServer.findMany({
      where: { userId: session.userId, enabled: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  // One phase per server, keyed by the server id and labelled with its name, so
  // a mixed Tracearr/native set of servers renders as one coherent bar with
  // each server named as it is worked on.
  const phases: ProgressPhase[] = servers.map((server) => ({
    key: server.id,
    label: server.name,
  }));

  return progressStreamResponse(
    async (emit, signal) => {
      emit({ type: "plan", phases });

      const counts: Record<string, number> = {};

      for (const server of servers) {
        // The client has gone (disconnect) or the lifetime cap fired — stop
        // starting new servers rather than running the whole set to completion
        // for nobody. Servers already done keep their counts; the ones not
        // reached simply stay absent from `counts`, and the next run redoes
        // them from a consistent state (see MAX_SYNC_LIFETIME_MS).
        if (signal.aborted) break;

        // Mark the phase active before any work happens. The bar's overall
        // position is derived from the index of the current phase key, so
        // without this opening event a server that reports no progress at all
        // (nothing new to import, or a fast failure) would never become
        // current and the bar would sit on the previous server. No `fraction`
        // and no `detail`: nothing is known yet, so the phase starts
        // indeterminate.
        emit({ type: "phase", key: server.id });

        try {
          const result = await syncWatchHistory(
            server.id,
            (progress: WatchHistoryProgress) =>
              emit({
                type: "phase",
                key: server.id,
                // Pass `fraction` through exactly as reported. It is ABSENT on
                // the Tracearr path (keyset pagination exposes no total, so any
                // percentage would be invented) and present on the native one,
                // and `useStreamProgress` reads `fraction !== undefined` to
                // choose a determinate bar over an indeterminate slider.
                // Coercing an absent fraction to 0 here would fake a bar
                // frozen at 0% for the entire import.
                fraction: progress.fraction,
                detail: progress.detail,
              }),
            // Cancels mid-server, not just between servers. Without this a
            // 160k-play Tracearr import would keep paging for minutes after
            // the user hit Stop or closed the tab, because the loop's
            // `signal.aborted` check above only runs between servers.
            signal,
          );
          counts[server.id] = result.count;
        } catch {
          // A cancel is not a failure. The native path deliberately THROWS on
          // abort so its full-replace transaction rolls back (breaking would
          // commit a half-rewritten history), which lands here — and recording
          // -1 would show the user a "couldn't sync" error toast for a Stop
          // they pressed themselves. Leave the server absent from `counts` and
          // let the `cancelled` flag below explain the run.
          if (signal.aborted) break;

          // A genuinely unreachable server must not abort the rest of the set.
          // -1 is the "this server failed" sentinel the History page reads.
          counts[server.id] = -1;
        }
      }

      // Invalidate cached filter dropdown values
      appCache.invalidatePrefix("watch-history-filters:");

      // Tell the client the run was cut short so it can say "run Refresh again
      // to continue" rather than implying the history is now complete. A first
      // Tracearr import of a very large history can legitimately outlast the
      // lifetime cap, and the user needs to know one more run will finish it.
      return { success: true, counts, cancelled: signal.aborted };
    },
    { signal: request.signal, maxLifetimeMs: MAX_SYNC_LIFETIME_MS },
  );
}
