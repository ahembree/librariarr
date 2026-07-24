import { prisma } from "@/lib/db";

/**
 * Time-windowed watch analytics over the `WatchHistory` play log. These are the
 * "small add" aggregations the dashboard/query engine don't provide: cumulative
 * `playCount` answers "most-played of all time", but genuine "what's popular
 * right now" and "who watches what" need a rolling window over
 * `WatchHistory.watchedAt`. Read-only; used by the AI analysis tools.
 */

// serverUsername is NOT NULL; deviceName / platform are nullable (COALESCE'd).
const WATCH_GROUP_COLUMNS: Record<string, string> = {
  user: "serverUsername",
  device: "deviceName",
  platform: "platform",
};

export interface WatchTrendRow {
  title: string;
  type: string;
  plays: number;
  users: number;
  lastWatchedAt: Date | null;
}

export interface WatchLeaderboardRow {
  key: string;
  plays: number;
  items: number;
  lastWatchedAt: Date | null;
}

function cutoff(days: number): Date {
  const clamped = Math.max(1, Math.min(3650, Math.floor(days)));
  return new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

/**
 * Rank titles by number of plays within a rolling window (rolling "trending").
 * Movies are keyed by their own title; series and music episodes/tracks are
 * rolled up to their parent (series name / artist) so a binge counts toward the
 * show, not individual episodes. Scoped to `serverIds` and, when a `mediaType`
 * is given, to that type. `users` is the distinct-viewer count.
 */
export async function computeWatchTrends(
  serverIds: string[],
  opts: { mediaType?: "MOVIE" | "SERIES" | "MUSIC"; days: number; limit: number },
): Promise<WatchTrendRow[]> {
  if (serverIds.length === 0) return [];
  const limit = clampLimit(opts.limit);
  const since = cutoff(opts.days);

  if (opts.mediaType) {
    // Movies key by title; series/music key by parentTitle.
    const titleExpr = opts.mediaType === "MOVIE" ? "mi.title" : 'mi."parentTitle"';
    return prisma.$queryRawUnsafe<WatchTrendRow[]>(
      `SELECT ${titleExpr} AS "title", mi.type::text AS "type",
         COUNT(*)::int AS "plays",
         COUNT(DISTINCT wh."serverUsername")::int AS "users",
         MAX(wh."watchedAt") AS "lastWatchedAt"
       FROM "WatchHistory" wh
       JOIN "MediaItem" mi ON wh."mediaItemId" = mi.id
       WHERE wh."mediaServerId" = ANY($1)
         AND wh."watchedAt" IS NOT NULL AND wh."watchedAt" >= $2
         AND mi.type::text = $3
         AND ${titleExpr} IS NOT NULL
       GROUP BY ${titleExpr}, mi.type
       ORDER BY "plays" DESC
       LIMIT $4`,
      serverIds, since, opts.mediaType, limit,
    );
  }

  return prisma.$queryRawUnsafe<WatchTrendRow[]>(
    `SELECT
       CASE WHEN mi.type = 'MOVIE' THEN mi.title ELSE mi."parentTitle" END AS "title",
       mi.type::text AS "type",
       COUNT(*)::int AS "plays",
       COUNT(DISTINCT wh."serverUsername")::int AS "users",
       MAX(wh."watchedAt") AS "lastWatchedAt"
     FROM "WatchHistory" wh
     JOIN "MediaItem" mi ON wh."mediaItemId" = mi.id
     WHERE wh."mediaServerId" = ANY($1)
       AND wh."watchedAt" IS NOT NULL AND wh."watchedAt" >= $2
       AND (mi.type = 'MOVIE' OR mi."parentTitle" IS NOT NULL)
     GROUP BY CASE WHEN mi.type = 'MOVIE' THEN mi.title ELSE mi."parentTitle" END, mi.type
     ORDER BY "plays" DESC
     LIMIT $3`,
    serverIds, since, limit,
  );
}

/**
 * Rank users / devices / platforms by number of plays within a rolling window.
 * `items` is the distinct number of titles/episodes each entity played.
 */
export async function computeWatchLeaderboard(
  serverIds: string[],
  opts: { groupBy: "user" | "device" | "platform"; days: number; limit: number },
): Promise<WatchLeaderboardRow[]> {
  if (serverIds.length === 0) return [];
  const column = WATCH_GROUP_COLUMNS[opts.groupBy];
  if (!column) throw new Error(`Invalid watch leaderboard grouping: ${opts.groupBy}`);
  const limit = clampLimit(opts.limit);
  const since = cutoff(opts.days);

  return prisma.$queryRawUnsafe<WatchLeaderboardRow[]>(
    `SELECT COALESCE(wh."${column}", 'Unknown') AS "key",
       COUNT(*)::int AS "plays",
       COUNT(DISTINCT wh."mediaItemId")::int AS "items",
       MAX(wh."watchedAt") AS "lastWatchedAt"
     FROM "WatchHistory" wh
     WHERE wh."mediaServerId" = ANY($1)
       AND wh."watchedAt" IS NOT NULL AND wh."watchedAt" >= $2
     GROUP BY "key"
     ORDER BY "plays" DESC
     LIMIT $3`,
    serverIds, since, limit,
  );
}
