/**
 * Recomputes dedupCanonical flags for a user's media items.
 *
 * After each sync, server deletion, or preference change, this module
 * marks exactly one item per dedupKey group as canonical (the representative
 * item shown in listings). The preferred title server gets priority.
 */

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { withDeadlockRetry } from "@/lib/db-retry";
import { computeDedupKey } from "./compute-dedup-key";

/**
 * Recompute canonical flags for all items belonging to a user.
 * Picks one item per dedupKey group, preferring the given server.
 */
export async function recomputeCanonical(userId: string): Promise<void> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { preferredTitleServerId: true },
  });
  const preferredServerId = settings?.preferredTitleServerId ?? null;

  // Single atomic UPDATE: set dedupCanonical based on whether each item is the
  // canonical pick for its dedupKey group. Wrapped in deadlock retry because
  // concurrent syncs for the same user can deadlock with processBatch upserts.
  await withDeadlockRetry("recomputeCanonical", async () => {
    if (preferredServerId) {
      await prisma.$executeRaw`
        UPDATE "MediaItem" mi_outer SET "dedupCanonical" = (
          mi_outer.id IN (
            SELECT DISTINCT ON (mi."dedupKey") mi.id
            FROM "MediaItem" mi
            JOIN "Library" l ON mi."libraryId" = l.id
            JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
            WHERE ms."userId" = ${userId} AND mi."dedupKey" IS NOT NULL
            ORDER BY mi."dedupKey",
              CASE WHEN l."mediaServerId" = ${preferredServerId} THEN 0 ELSE 1 END,
              mi."createdAt" ASC
          )
        )
        WHERE mi_outer."libraryId" IN (
          SELECT l.id FROM "Library" l
          JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
          WHERE ms."userId" = ${userId}
        )
        AND mi_outer."dedupKey" IS NOT NULL
      `;
    } else {
      // No preference — oldest item per group wins
      await prisma.$executeRaw`
        UPDATE "MediaItem" mi_outer SET "dedupCanonical" = (
          mi_outer.id IN (
            SELECT DISTINCT ON (mi."dedupKey") mi.id
            FROM "MediaItem" mi
            JOIN "Library" l ON mi."libraryId" = l.id
            JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
            WHERE ms."userId" = ${userId} AND mi."dedupKey" IS NOT NULL
            ORDER BY mi."dedupKey", mi."createdAt" ASC
          )
        )
        WHERE mi_outer."libraryId" IN (
          SELECT l.id FROM "Library" l
          JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
          WHERE ms."userId" = ${userId}
        )
        AND mi_outer."dedupKey" IS NOT NULL
      `;
    }
  });

  // Ensure items without dedupKey stay canonical (default).
  // These are items that haven't been synced yet or have no computable key.
  // This targets a disjoint set (dedupKey IS NULL) so no deadlock risk.
  await prisma.$executeRaw`
    UPDATE "MediaItem" SET "dedupCanonical" = true
    WHERE "libraryId" IN (
      SELECT l.id FROM "Library" l
      JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
      WHERE ms."userId" = ${userId}
    )
    AND "dedupKey" IS NULL
    AND "dedupCanonical" = false
  `;

  logger.info("Sync", "Dedup canonical flags recomputed");
}

/**
 * Backfill dedupKeys for items that don't have one yet.
 * Used after migration or when items were synced before dedupKey was added.
 */
export async function backfillDedupKeys(userId?: string): Promise<number> {
  // Fetch items missing dedupKey in batches
  const BATCH_SIZE = 1000;
  let totalUpdated = 0;
  let hasMore = true;

  while (hasMore) {
    // Use parameterized query to avoid SQL injection
    const items = userId
      ? await prisma.$queryRaw<
          {
            id: string;
            type: string;
            title: string;
            year: number | null;
            parentTitle: string | null;
            seasonNumber: number | null;
            episodeNumber: number | null;
            userId: string;
          }[]
        >`SELECT mi.id, mi.type::text, mi.title, mi.year, mi."parentTitle",
                mi."seasonNumber", mi."episodeNumber", ms."userId"
         FROM "MediaItem" mi
         JOIN "Library" l ON mi."libraryId" = l.id
         JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
         WHERE mi."dedupKey" IS NULL AND ms."userId" = ${userId}
         LIMIT ${BATCH_SIZE}`
      : await prisma.$queryRaw<
          {
            id: string;
            type: string;
            title: string;
            year: number | null;
            parentTitle: string | null;
            seasonNumber: number | null;
            episodeNumber: number | null;
            userId: string;
          }[]
        >`SELECT mi.id, mi.type::text, mi.title, mi.year, mi."parentTitle",
                mi."seasonNumber", mi."episodeNumber", ms."userId"
         FROM "MediaItem" mi
         JOIN "Library" l ON mi."libraryId" = l.id
         JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
         WHERE mi."dedupKey" IS NULL
         LIMIT ${BATCH_SIZE}`;

    if (items.length === 0) {
      hasMore = false;
      break;
    }

    // For movies, fetch external IDs in bulk
    const movieIds = items
      .filter((i) => i.type === "MOVIE")
      .map((i) => i.id);

    const externalIds =
      movieIds.length > 0
        ? await prisma.mediaItemExternalId.findMany({
            where: { mediaItemId: { in: movieIds } },
            select: { mediaItemId: true, source: true, externalId: true },
          })
        : [];

    const extIdMap = new Map<string, { source: string; id: string }[]>();
    for (const eid of externalIds) {
      const existing = extIdMap.get(eid.mediaItemId) ?? [];
      existing.push({ source: eid.source, id: eid.externalId });
      extIdMap.set(eid.mediaItemId, existing);
    }

    // Build parameterized updates and execute in a transaction
    const updates = items.map((item) => {
      const key = computeDedupKey(
        item.type as "MOVIE" | "SERIES" | "MUSIC",
        item.title,
        {
          year: item.year,
          parentTitle: item.parentTitle,
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
          externalIds: extIdMap.get(item.id),
        },
      );
      return prisma.$executeRaw`
        UPDATE "MediaItem" SET "dedupKey" = ${key} WHERE id = ${item.id}
      `;
    });
    await prisma.$transaction(updates);

    totalUpdated += items.length;
    hasMore = items.length === BATCH_SIZE;
  }

  return totalUpdated;
}

/**
 * Check on startup if any items need dedupKey backfill.
 * Runs in the background — does not block server startup.
 */
export async function runBackfillIfNeeded(): Promise<void> {
  try {
    const [{ count }] = await prisma.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "MediaItem" WHERE "dedupKey" IS NULL LIMIT 1
    `;

    if (count === 0) return;

    logger.info("Sync", `Backfilling dedupKeys for ${count} item(s)...`);
    const updated = await backfillDedupKeys();
    logger.info("Sync", `Backfilled ${updated} dedupKey(s)`);

    // Recompute canonical for all affected users
    const users = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT DISTINCT ms."userId"
      FROM "MediaItem" mi
      JOIN "Library" l ON mi."libraryId" = l.id
      JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
    `;

    for (const { userId } of users) {
      await recomputeCanonical(userId);
    }
  } catch (error) {
    logger.error("Sync", "Dedup backfill failed", { error: String(error) });
  }
}
