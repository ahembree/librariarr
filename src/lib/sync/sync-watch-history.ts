import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
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
    }[]
  >(
    `SELECT "id","name","url","accessToken","type","tlsSkipVerify","enabled" FROM "MediaServer" WHERE "id"=$1`,
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
  const seen = new Set<string>();
  const dedupedEntries: typeof entries = [];
  for (const entry of entries) {
    const key = `${entry.ratingKey}|${entry.username}|${entry.watchedAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

  return { count: insertedCount };
}
