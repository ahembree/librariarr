import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { computeLibraryStats } from "@/lib/media/library-stats";

/**
 * Library statistics — a thin wrapper over the same shared compute the internal
 * stats route uses, so the two can never report different numbers. The cache key
 * is deliberately identical: both surfaces share one entry, and the single
 * `stats:` prefix that `invalidateMediaCaches()` drops clears both.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");

  const scope = await resolveStatsScope(userId, serverId);
  if (scope === "server-not-found") return v1Error("Server not found", 404);

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

  const cacheKey = `stats:${userId}:${serverId ?? "all"}:${scope.dedupEnabled ? "dedup" : "raw"}`;
  const result = await appCache.getOrSet(
    cacheKey,
    () => computeLibraryStats(scope.serverIds, scope.dedupEnabled),
    60_000,
  );

  return NextResponse.json(result);
});
