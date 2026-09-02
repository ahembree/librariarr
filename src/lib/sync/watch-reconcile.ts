import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Reconciliation between the `WatchHistory` table (the app's own complete,
 * ALL-users record of plays) and the two denormalized columns the rule/query
 * engines actually read: `MediaItem.playCount` and `MediaItem.lastPlayedAt`.
 *
 * Why this exists: those columns were only ever written by the *item* sync,
 * which derives them from the media server's per-item metadata — and that
 * metadata is scoped to the **authenticated account**:
 *
 *  - Plex: `viewCount`/`lastViewedAt` on `/library/sections/…` reflect the
 *    admin token's own views. Plays by other Plex Home / shared users are only
 *    visible through `/status/sessions/history/all`.
 *  - Jellyfin/Emby: `UserData` is fetched with the admin `UserId`, and
 *    `getWatchCounts()` returns an empty map by design, so plays by any other
 *    Jellyfin user never reached these columns at all.
 *
 * `WatchHistory`, by contrast, is populated from the server-wide, per-user
 * history (`getDetailedWatchHistory`). So the History page could show an
 * episode played two months ago while `lastPlayedAt` — and therefore the
 * `seriesLastPlayedAt` / `Series Last Played` aggregate, `playCount`,
 * `watchedEpisodeCount` and `watchedEpisodePercentage` — still reported the
 * admin's own view from two years earlier, silently arming lifecycle rules
 * against series someone in the household is actively watching.
 *
 * Both helpers are **monotonic**: they only ever move a play count up or a
 * play date forward, mirroring the `Math.max(metadata, history)` the item sync
 * already applies. A media server that prunes its history can therefore never
 * make an item look *less* recently watched than we know it to be — the safe
 * direction for an engine that deletes files.
 */

export interface WatchCountEntry {
  count: number;
  /** Epoch **seconds** — the unit `buildItemData` multiplies by 1000. */
  lastWatchedAt: number;
}

/**
 * Roll the stored `WatchHistory` rows for `ratingKeys` up into the per-item
 * shape the item sync's `buildItemData` expects, so a sync path that has no
 * live server-wide history scan of its own (the incremental sync) still writes
 * all-users play state instead of clobbering it with admin-only metadata.
 */
export async function loadWatchCountsFromHistory(
  serverId: string,
  ratingKeys: string[],
): Promise<Map<string, WatchCountEntry>> {
  const counts = new Map<string, WatchCountEntry>();
  if (ratingKeys.length === 0) return counts;

  const rows = await prisma.$queryRawUnsafe<
    Array<{ ratingKey: string; plays: bigint | number; lastWatched: Date | null }>
  >(
    `SELECT mi."ratingKey" AS "ratingKey",
            COUNT(*)::int AS "plays",
            MAX(wh."watchedAt") AS "lastWatched"
       FROM "WatchHistory" wh
       JOIN "MediaItem" mi ON mi."id" = wh."mediaItemId"
      WHERE wh."mediaServerId"=$1 AND mi."ratingKey" = ANY($2)
      GROUP BY mi."ratingKey"`,
    serverId,
    ratingKeys,
  );

  for (const row of rows) {
    counts.set(row.ratingKey, {
      count: Number(row.plays),
      lastWatchedAt: row.lastWatched
        ? Math.floor(new Date(row.lastWatched).getTime() / 1000)
        : 0,
    });
  }

  return counts;
}

/**
 * Push the stored `WatchHistory` for a server into `MediaItem.playCount` /
 * `lastPlayedAt`, taking the greater of the existing and history-derived value
 * for each. Returns the number of rows actually changed.
 *
 * Runs after every watch-history sync — both the one inside a full sync and the
 * standalone one the realtime `watch-changed` event enqueues — so a play by any
 * user is reflected in the columns the rule engine reads without waiting for
 * the next full sync.
 */
export async function reconcileWatchStateFromHistory(
  serverId: string,
): Promise<number> {
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "MediaItem" mi
        SET "playCount" = GREATEST(mi."playCount", hist."plays"),
            "lastPlayedAt" = GREATEST(mi."lastPlayedAt", hist."lastWatched")
       FROM (
         SELECT "mediaItemId",
                COUNT(*)::int AS "plays",
                MAX("watchedAt") AS "lastWatched"
           FROM "WatchHistory"
          WHERE "mediaServerId"=$1
          GROUP BY "mediaItemId"
       ) hist
      WHERE mi."id" = hist."mediaItemId"
        AND (mi."playCount" < hist."plays"
             OR mi."lastPlayedAt" IS DISTINCT FROM GREATEST(mi."lastPlayedAt", hist."lastWatched"))`,
    serverId,
  );

  if (updated > 0) {
    logger.info(
      "WatchHistory",
      `Reconciled play state for ${updated} item(s) from stored watch history`,
    );
  }

  return updated;
}
