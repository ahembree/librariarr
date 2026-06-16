import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import type { MediaServerType } from "@/generated/prisma/client";

// 500 rows × 10 params = 5000 bind params per INSERT — well under Postgres's
// 65535 limit, while keeping the full-replace transaction's round-trips low.
const BATCH_SIZE = 500;

// DELETE + all INSERTs run as one interactive transaction so a mid-insert
// failure rolls back rather than leaving the native rows wiped. Large histories
// easily exceed Prisma's 5s default, so give it a generous window.
const TX_OPTIONS = { timeout: 120_000, maxWait: 15_000 } as const;

/**
 * Sync a media server's native watch history into WatchHistory.
 *
 * Plex/Jellyfin/Emby each return their *full* history every call, so this does a
 * replace of the **native-only** rows: it deletes rows with no Tautulli linkage
 * (`tautulliRowId IS NULL`) and re-inserts the fetched set, upserting on the
 * `(mediaServerId, serverHistoryKey)` key. Tautulli-only and Plex+Tautulli
 * (merged) rows are preserved — for a merged row the upsert refreshes the
 * native fields via ON CONFLICT without clobbering the Tautulli enrichment or
 * the `source` marker. This replaced the old unconditional full-replace, which
 * would have wiped Tautulli data on every native sync.
 */
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

  // A fetch failure must NOT reach the destructive replace below: the client
  // throws on a hard failure so we can skip the wipe (an empty array here
  // therefore means the server genuinely reported no plays).
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
    // Clear native-only rows (in case items were removed) but preserve any
    // Tautulli-linked rows for this server.
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1 AND "tautulliRowId" IS NULL`,
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

  // Dedupe by the native history-event key before inserting — a multi-row INSERT
  // cannot hit the same ON CONFLICT target twice ("cannot affect row a second
  // time"), and the source occasionally repeats an event.
  const seen = new Set<string>();
  const dedupedEntries: typeof entries = [];
  for (const entry of entries) {
    if (seen.has(entry.historyKey)) continue;
    seen.add(entry.historyKey);
    dedupedEntries.push(entry);
  }

  let insertedCount = 0;
  const { randomUUID } = await import("crypto");

  await prisma.$transaction(async (tx) => {
    // Replace native-only rows; preserve Tautulli-linked rows.
    await tx.$executeRawUnsafe(
      `DELETE FROM "WatchHistory" WHERE "mediaServerId"=$1 AND "tautulliRowId" IS NULL`,
      serverId
    );

    for (let i = 0; i < dedupedEntries.length; i += BATCH_SIZE) {
      const batch = dedupedEntries.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (const entry of batch) {
        const mediaItemId = ratingKeyToId.get(entry.ratingKey);
        if (!mediaItemId) continue;

        values.push(
          `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`
        );
        params.push(
          randomUUID(),
          mediaItemId,
          serverId,
          entry.username,
          entry.watchedAt ? new Date(entry.watchedAt) : null,
          entry.deviceName,
          entry.platform,
          server.type, // source: "PLEX" | "JELLYFIN" | "EMBY"
          entry.historyKey,
          new Date()
        );
      }

      if (values.length > 0) {
        // ON CONFLICT keeps merged (Plex+Tautulli) rows intact: refresh the
        // native fields but never overwrite `source` or the Tautulli columns.
        await tx.$executeRawUnsafe(
          `INSERT INTO "WatchHistory"
             ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","deviceName","platform","source","serverHistoryKey","createdAt")
           VALUES ${values.join(",")}
           ON CONFLICT ("mediaServerId","serverHistoryKey") DO UPDATE SET
             "serverUsername"=EXCLUDED."serverUsername",
             "watchedAt"=EXCLUDED."watchedAt",
             "deviceName"=EXCLUDED."deviceName",
             "platform"=EXCLUDED."platform"`,
          ...params
        );
        insertedCount += values.length;
      }
    }
  }, TX_OPTIONS);

  logger.info(
    "WatchHistory",
    `Synced ${insertedCount} native watch history entries for "${server.name}" ` +
      `(${dedupedEntries.length - insertedCount} unmatched, ` +
      `${entries.length - dedupedEntries.length} duplicates removed)`
  );

  return { count: insertedCount };
}
