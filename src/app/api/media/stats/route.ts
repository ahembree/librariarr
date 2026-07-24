import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { computeLibraryStats } from "@/lib/media/library-stats";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const serverId = searchParams.get("serverId");

  const scope = await resolveStatsScope(session.userId!, serverId);
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (scope.serverIds.length === 0) {
    return NextResponse.json({
      movieCount: 0,
      seriesCount: 0,
      seasonCount: 0,
      musicCount: 0,
      artistCount: 0,
      albumCount: 0,
      episodeCount: 0,
      totalSize: "0",
      movieSize: "0",
      seriesSize: "0",
      musicSize: "0",
      movieDuration: 0,
      seriesDuration: 0,
      musicDuration: 0,
      qualityBreakdown: [],
      topMovies: [],
      topSeries: [],
      topMusic: [],
      videoCodecBreakdown: [],
      audioCodecBreakdown: [],
      contentRatingBreakdown: [],
      dynamicRangeBreakdown: [],
      audioChannelsBreakdown: [],
      genreBreakdown: [],
    });
  }

  const cacheKey = `stats:${session.userId}:${serverId ?? "all"}:${scope.dedupEnabled ? "dedup" : "raw"}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () => computeLibraryStats(scope.serverIds, scope.dedupEnabled),
    60_000,
  );
  return NextResponse.json(result);
}
