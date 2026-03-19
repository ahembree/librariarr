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

  // Full replace: delete existing watch history for this server
  await prisma.$queryRawUnsafe(
    `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1`,
    serverId
  );

  // Batch insert new records
  let insertedCount = 0;
  const { randomUUID } = await import("crypto");

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
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
      await prisma.$queryRawUnsafe(
        `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","createdAt")
         VALUES ${values.join(",")}`,
        ...params
      );
      insertedCount += values.length;
    }

    // Yield between batches
    if (i + BATCH_SIZE < entries.length) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} watch history entries for "${server.name}" (${entries.length - insertedCount} unmatched)`
  );

  return { count: insertedCount };
}
