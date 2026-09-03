import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import type { MediaServerType } from "@/generated/prisma/client";

// 500 rows × 8 params = 4000 bind params per INSERT — well under Postgres's
// 65535 limit, but ~5× fewer round-trips than 100, which keeps the full-replace
// transaction comfortably inside its timeout on large histories.
const BATCH_SIZE = 500;

// The full-replace runs as a single interactive transaction (DELETE + all
// INSERTs) so a mid-insert failure rolls back rather than leaving the table
// empty. A large history easily exceeds Prisma's 5s default, so give the
// transaction a generous window (and a longer connection wait under load).
const TX_OPTIONS = { timeout: 120_000, maxWait: 15_000 } as const;

export async function syncWatchHistory(
  serverId: string
): Promise<{ count: number }> {
  // Load server record
  const serverRows = await prisma.$queryRawUnsafe<
    {
      id: string;
      name: string;
      url: string;
      accessToken: string;
      type: string;
      tlsSkipVerify: boolean;
      enabled: boolean;
      userId: string;
      tracearrServerId: string | null;
    }[]
  >(
    `SELECT "id","name","url","accessToken","type","tlsSkipVerify","enabled","userId","tracearrServerId" FROM "MediaServer" WHERE "id"=$1`,
    serverId
  );

  if (serverRows.length === 0) {
    throw new Error(`MediaServer not found: ${serverId}`);
  }
  const server = serverRows[0];

  if (!server.enabled) {
    logger.info(
      "WatchHistory",
      `Skipping watch history sync for disabled server "${server.name}"`
    );
    return { count: 0 };
  }

  // Watch history has two possible provenances per server, and they are
  // mutually exclusive: mapping this server to a Tracearr `server_id` replaces
  // the native full-replace below with an incremental, append/upsert import
  // from Tracearr's durable log (`sync-tracearr-history.ts`). Running both
  // would be actively destructive — the native path DELETEs every row for the
  // server before re-inserting, so it would wipe the imported Tracearr rows on
  // each run and then the importer's watermark would re-pull them.
  //
  // The mapping alone is not enough: an admin can map a server and later
  // disable (or delete) the instance. When that happens we must SKIP, not fall
  // back to the native path, because falling back is doubly destructive:
  //
  //  1. The native full-replace below DELETEs every row for the server —
  //     including the imported Tracearr rows — so a temporarily disabled
  //     instance would silently destroy the richer history it was mapped for.
  //  2. Worse, it is not self-correcting. Once those rows are gone the
  //     importer's watermark (MAX(watchedAt) WHERE source='TRACEARR') is null
  //     again, so re-enabling the instance triggers a full re-pull that APPENDS
  //     every play back alongside the NATIVE rows the fallback just wrote. The
  //     same play then exists twice, `reconcileWatchStateFromHistory` counts
  //     both, and `MediaItem.playCount` — which is monotonic and drives
  //     destructive lifecycle rules — is permanently doubled.
  //
  // Leaving the existing rows untouched is strictly better than either: the
  // history simply stops advancing until the admin re-enables the instance or
  // clears the mapping (which wipes the rows deliberately, via the server PUT).
  if (server.tracearrServerId) {
    const instance = await prisma.tracearrInstance.findFirst({
      where: { userId: server.userId, enabled: true },
      select: { id: true },
    });

    if (!instance) {
      logger.warn(
        "WatchHistory",
        `"${server.name}" is mapped to a Tracearr server but no enabled Tracearr ` +
          `instance is configured — skipping this sync and leaving the stored ` +
          `history intact. Re-enable the instance, or clear the server's ` +
          `watch-history source to go back to the server's own history.`
      );
      return { count: 0 };
    }

    logger.info(
      "WatchHistory",
      `Using Tracearr as the watch-history source for "${server.name}"`
    );
    return syncTracearrHistory(serverId);
  }

  logger.debug(
    "WatchHistory",
    `Using native watch history for "${server.name}"`
  );

  const client = createMediaServerClient(
    server.type as MediaServerType,
    server.url,
    server.accessToken,
    { skipTlsVerify: server.tlsSkipVerify }
  );

  logger.info(
    "WatchHistory",
    `Fetching detailed watch history from "${server.name}"...`
  );

  // A fetch failure must NOT reach the destructive full-replace below: the
  // client throws on a hard failure so we can skip the wipe (an empty array
  // here therefore means the server genuinely reported no plays).
  let entries: Awaited<ReturnType<typeof client.getDetailedWatchHistory>>;
  try {
    entries = await client.getDetailedWatchHistory();
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Skipping watch history sync for "${server.name}" — fetch failed; leaving existing history intact`,
      { error: String(error) }
    );
    return { count: 0 };
  }
  logger.info(
    "WatchHistory",
    `Got ${entries.length} play events from "${server.name}"`
  );

  if (entries.length === 0) {
    // Still clear old records in case items were removed
    await prisma.$queryRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
      serverId
    );
    return { count: 0 };
  }

  // Build a lookup from ratingKey -> mediaItemId for this server's items
  const mediaItems = await prisma.$queryRawUnsafe<
    { id: string; ratingKey: string }[]
  >(
    `SELECT mi."id", mi."ratingKey" FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l."id"
     WHERE l."mediaServerId"=$1`,
    serverId
  );

  const ratingKeyToId = new Map<string, string>();
  for (const item of mediaItems) {
    ratingKeyToId.set(item.ratingKey, item.id);
  }

  // Dedupe entries in memory before inserting. There is no DB unique constraint
  // on WatchHistory (intentional), so identical play events from the source
  // (same item, user, and watchedAt) would otherwise become duplicate rows.
  //
  // Only TIMESTAMPED entries are deduped. An entry with no `watchedAt` is not a
  // repeat of another one — it is how a server that reports a play COUNT
  // without per-play timestamps represents one of those plays. Jellyfin and
  // Emby do exactly that: `getDetailedWatchHistory` emits `UserData.PlayCount`
  // entries per item/user and only the first carries `LastPlayedDate`, so a
  // key of `ratingKey|username|(watchedAt ?? "")` collapsed all the undated
  // ones into a single row and an item played five times stored two — capping
  // `playCount` at 2 per user everywhere it is read (the Play Count column,
  // the hover card, and `playCount` lifecycle rules), while the per-item
  // history panel, which queries the server live, still showed five.
  const seen = new Set<string>();
  const dedupedEntries: typeof entries = [];
  for (const entry of entries) {
    if (entry.watchedAt) {
      const key = `${entry.ratingKey}|${entry.username}|${entry.watchedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    dedupedEntries.push(entry);
  }

  // Batch insert new records
  let insertedCount = 0;
  const { randomUUID } = await import("crypto");

  // Wrap the full-replace DELETE and all batch INSERTs in a single transaction
  // so a mid-insert failure rolls back instead of leaving the table empty
  // (the previous out-of-transaction version permanently wiped history on any
  // insert error until the next successful sync).
  await prisma.$transaction(async (tx) => {
    // Full replace: delete existing watch history for this server
    await tx.$executeRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
      serverId
    );

    for (let i = 0; i < dedupedEntries.length; i += BATCH_SIZE) {
      const batch = dedupedEntries.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const entry of batch) {
        const mediaItemId = ratingKeyToId.get(entry.ratingKey);
        if (!mediaItemId) continue;

        values.push(
          `($${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++},$${paramIndex++})`
        );
        params.push(
          randomUUID(),
          mediaItemId,
          serverId,
          entry.username,
          entry.watchedAt ? new Date(entry.watchedAt) : null,
          entry.deviceName,
          entry.platform,
          new Date()
        );
      }

      if (values.length > 0) {
        // No setImmediate yield between batches: the awaited DB round-trip
        // already yields the event loop, and an extra macrotask only burns the
        // interactive-transaction timeout budget.
        await tx.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
           VALUES ${values.join(",")}`,
          ...params
        );
        insertedCount += values.length;
      }
    }
  }, TX_OPTIONS);

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" ` +
      `(${dedupedEntries.length - insertedCount} unmatched, ` +
      `${entries.length - dedupedEntries.length} duplicates removed)`
  );

  // Push the freshly stored history into `MediaItem.playCount`/`lastPlayedAt`.
  // Those columns are what the rule and query engines read (`lastPlayedAt`, and
  // the `seriesLastPlayedAt` aggregate rolled up from it), but the item sync
  // derives them from account-scoped server metadata — so a play by any other
  // user on the server landed in `WatchHistory` and nowhere else. Non-fatal:
  // the history rows are already committed, so a failure here is corrected by
  // the next sync rather than being worth failing the whole run over.
  try {
    await reconcileWatchStateFromHistory(serverId);
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Failed to reconcile play state from watch history for "${server.name}"`,
      { error: String(error) }
    );
  }

  return { count: insertedCount };
}
