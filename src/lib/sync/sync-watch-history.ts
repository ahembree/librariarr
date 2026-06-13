import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import type { MediaServerType } from "@/generated/prisma/client";

const BATCH_SIZE = 100;

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

  const entries = await client.getDetailedWatchHistory();
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
        await tx.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
           VALUES ${values.join(",")}`,
          ...params
        );
        insertedCount += values.length;
      }

      // Yield between batches
      if (i + BATCH_SIZE < dedupedEntries.length) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }
  });

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" ` +
      `(${dedupedEntries.length - insertedCount} unmatched, ` +
      `${entries.length - dedupedEntries.length} duplicates removed)`
  );

  return { count: insertedCount };
}
