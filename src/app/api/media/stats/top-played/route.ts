import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { computeTopPlayedInWindow } from "@/lib/media/top-played-window";
import { isPlayRange, playRangeSince } from "@/lib/dashboard/play-range";

/**
 * Under `stats:`, so every sync and watch-history import that calls
 * `invalidateMediaCaches()` drops it. Short, since the window rolls.
 */
const TOP_PLAYED_TTL_MS = 5 * 60_000;

/**
 * The Top Played card's lists over a time-range preset
 * (`range=week|month|3months|year`). All time is the stats payload's own lists
 * (`GET /api/media/stats`).
 */
export const GET = withSession(async (session, request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const range = searchParams.get("range");
  if (!isPlayRange(range)) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }
  const serverId = searchParams.get("serverId");

  const scope = await resolveStatsScope(session.userId, serverId);
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  if (scope.serverIds.length === 0) {
    return NextResponse.json({ topMovies: [], topSeries: [], topMusic: [] });
  }

  const cacheKey = `stats:top-played:${range}:${serverId ?? "all"}:${scope.dedupEnabled ? "dedup" : "raw"}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () => computeTopPlayedInWindow(scope.serverIds, scope.dedupEnabled, playRangeSince(range)),
    TOP_PLAYED_TTL_MS,
  );
  return NextResponse.json(result);
});
