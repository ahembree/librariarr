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
import { seriesKeySqlExpression } from "@/lib/media/series-key";

/**
 * Recompute canonical flags for all items belonging to a user.
 * Picks one item per dedupKey group: a copy on an ENABLED server first, then
 * the preferred title server, then the oldest. Disabling a server without
 * deleting its data keeps its items; if one of them stayed canonical, every
 * query that combines `dedupCanonical = true` with the enabled-server scope
 * (the multi-server listings, the Seerr request stats) lost the title entirely.
 * Groups that exist only on disabled servers still get a canonical copy.
 *
 * Only rows whose flag actually changes are written. The previous form set the
 * flag on EVERY row the user owns on every call — after every full and
 * incremental sync — which rewrote (and re-indexed) a whole library's worth of
 * tuples to change, usually, nothing.
 *
 * `options.dedupKeys` limits the recompute to those groups. A caller that knows
 * exactly which rows it wrote (the incremental sync) passes the keys of every
 * row it upserted or deleted, before AND after the write, because a row whose
 * key changed leaves one group and joins another, and a deleted row's group
 * must elect a new canonical copy. Omitted, every group is recomputed.
 */
export async function recomputeCanonical(
  userId: string,
  options: { dedupKeys?: string[] } = {},
): Promise<void> {
  const scoped = options.dedupKeys !== undefined;
  const dedupKeys = [...new Set(options.dedupKeys ?? [])];
  if (scoped && dedupKeys.length === 0) return;

  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { preferredTitleServerId: true },
  });
  const preferredServerId = settings?.preferredTitleServerId ?? null;

  // Winners are ranked once per group: a copy on an enabled server first, then
  // the preferred title server, then the oldest, then the id — the last only so
  // that two copies created in the same statement (same `createdAt`) cannot
  // swap places between runs and turn every recompute into a rewrite. With no
  // preference the second term is NULL = x, which ranks every copy equally.
  //
  // Wrapped in deadlock retry because concurrent syncs for the same user can
  // deadlock with processBatch upserts.
  await withDeadlockRetry("recomputeCanonical", async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaItem" mi SET "dedupCanonical" = r."winner"
         FROM (
           SELECT x."id", x."dedupCanonical",
                  ROW_NUMBER() OVER (
                    PARTITION BY x."dedupKey"
                    ORDER BY CASE WHEN ms."enabled" THEN 0 ELSE 1 END,
                             CASE WHEN l."mediaServerId" = $2::text THEN 0 ELSE 1 END,
                             x."createdAt" ASC,
                             x."id" ASC
                  ) = 1 AS "winner"
             FROM "MediaItem" x
             JOIN "Library" l ON x."libraryId" = l."id"
             JOIN "MediaServer" ms ON l."mediaServerId" = ms."id"
            WHERE ms."userId" = $1 AND x."dedupKey" IS NOT NULL
              ${scoped ? `AND x."dedupKey" = ANY($3::text[])` : ""}
         ) r
        WHERE mi."id" = r."id" AND r."dedupCanonical" IS DISTINCT FROM r."winner"`,
      ...(scoped ? [userId, preferredServerId, dedupKeys] : [userId, preferredServerId]),
    );
  });

  // Ensure items without dedupKey stay canonical (default).
  // These are items that haven't been synced yet or have no computable key.
  // This targets a disjoint set (dedupKey IS NULL) so no deadlock risk. A
  // scoped call only ever names keys, and every row a sync writes has one, so
  // there is nothing for it to fix there.
  if (!scoped) {
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
  }

  logger.info(
    "Sync",
    scoped
      ? `Dedup canonical flags recomputed for ${dedupKeys.length} group(s)`
      : "Dedup canonical flags recomputed",
  );
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

    // External ids for every type whose key reads them — movies (TMDB/IMDB)
    // and episodes (the stored series-level TVDB). Loading them for movies alone
    // gave a backfilled episode `series:<title>:sXeY` where the sync writes
    // `series:tvdb:<id>:sXeY`, so the two copies never deduped. Track keys read
    // no external id.
    const keyedIds = items
      .filter((i) => i.type === "MOVIE" || i.type === "SERIES")
      .map((i) => i.id);

    const externalIds =
      keyedIds.length > 0
        ? await prisma.mediaItemExternalId.findMany({
            where: { mediaItemId: { in: keyedIds } },
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
 * Backfill `seriesKey` for SERIES rows that don't have one yet (synced before
 * the column existed, or a restore of a pre-0015 backup). Set-based and keyed
 * off the persisted show-level external ids via the shared SQL expression, so
 * it produces exactly what the sync's `buildRowParams` writes for new rows.
 * Movies/tracks are left NULL. Returns the number of rows updated.
 */
export async function backfillSeriesKeys(userId?: string): Promise<number> {
  const expr = seriesKeySqlExpression("mi");
  const ownership = userId
    ? `AND mi."libraryId" IN (
         SELECT l.id FROM "Library" l
         JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
         WHERE ms."userId" = $1
       )`
    : "";
  const sql = `
    UPDATE "MediaItem" mi
    SET "seriesKey" = ${expr}
    WHERE mi."type" = 'SERIES'::"LibraryType"
      AND mi."seriesKey" IS NULL
      ${ownership}
  `;
  return userId
    ? prisma.$executeRawUnsafe(sql, userId)
    : prisma.$executeRawUnsafe(sql);
}

/**
 * Check on startup if any items need dedupKey backfill.
 * Runs in the background — does not block server startup.
 */
export async function runBackfillIfNeeded(): Promise<void> {
  try {
    // seriesKey backfill is independent of dedupKey (SERIES rows only) and
    // cheap when there's nothing to do, so check it on its own.
    const [{ count: seriesKeyMissing }] = await prisma.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "MediaItem"
      WHERE "type" = 'SERIES'::"LibraryType" AND "seriesKey" IS NULL LIMIT 1
    `;
    if (seriesKeyMissing > 0) {
      logger.info("Sync", `Backfilling seriesKey for ${seriesKeyMissing} SERIES item(s)...`);
      const updatedSeriesKeys = await backfillSeriesKeys();
      logger.info("Sync", `Backfilled ${updatedSeriesKeys} seriesKey(s)`);
    }

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
