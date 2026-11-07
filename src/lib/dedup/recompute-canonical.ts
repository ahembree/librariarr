/**
 * Recomputes dedupCanonical flags for a user's media items.
 *
 * After each sync, server deletion, or preference change, this module
 * marks exactly one item per dedupKey group as canonical (the representative
 * item shown in listings). The preferred title server gets priority.
 */

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { withDeadlockRetry } from "@/lib/db-retry";
import { computeDedupKey, LEGACY_TRACK_DEDUP_KEY_PREFIX } from "./compute-dedup-key";
import { seriesKeySqlExpression } from "@/lib/media/series-key";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";

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

  // Wrapped in deadlock retry because concurrent syncs for the same user can
  // deadlock with processBatch upserts.
  await withDeadlockRetry("recomputeCanonical", () =>
    writeCanonicalFlags(prisma, userId, scoped ? dedupKeys : null),
  );

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
 * The canonical-flag write behind `recomputeCanonical`, on any client — the
 * legacy track re-key runs it inside the transaction that moves the keys.
 * `dedupKeys` scopes it to those groups; null recomputes every group.
 */
async function writeCanonicalFlags(
  client: Prisma.TransactionClient,
  userId: string,
  dedupKeys: string[] | null,
): Promise<void> {
  const settings = await client.appSettings.findUnique({
    where: { userId },
    select: { preferredTitleServerId: true },
  });
  const preferredServerId = settings?.preferredTitleServerId ?? null;

  // Winners are ranked once per group: a copy on an enabled server first, then
  // the preferred title server, then the oldest, then the id — the last only so
  // that two copies created in the same statement (same `createdAt`) cannot
  // swap places between runs and turn every recompute into a rewrite. With no
  // preference the second term is NULL = x, which ranks every copy equally.
  await client.$executeRawUnsafe(
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
            ${dedupKeys ? `AND x."dedupKey" = ANY($3::text[])` : ""}
       ) r
      WHERE mi."id" = r."id" AND r."dedupCanonical" IS DISTINCT FROM r."winner"`,
    ...(dedupKeys ? [userId, preferredServerId, dedupKeys] : [userId, preferredServerId]),
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
            albumTitle: string | null;
            seasonNumber: number | null;
            episodeNumber: number | null;
            userId: string;
          }[]
        >`SELECT mi.id, mi.type::text, mi.title, mi.year, mi."parentTitle", mi."albumTitle",
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
            albumTitle: string | null;
            seasonNumber: number | null;
            episodeNumber: number | null;
            userId: string;
          }[]
        >`SELECT mi.id, mi.type::text, mi.title, mi.year, mi."parentTitle", mi."albumTitle",
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
          albumTitle: item.albumTitle,
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
 * Legacy track-key groups re-keyed per transaction. A batch takes whole groups
 * — every row that shares an old key — so the copies of one track move to
 * their new group together and never sit in two groups between batches.
 */
const LEGACY_TRACK_GROUPS_PER_BATCH = 500;

export interface LegacyTrackRekeyResult {
  /** Rows given their new key (every batch that committed). */
  rekeyed: number;
  /**
   * The error that stopped the pass part-way, if one did. Every batch before it
   * is committed, keys and canonical flags alike; the rows it did not reach keep
   * their old key and are re-keyed by the next run.
   */
  error?: unknown;
}

/**
 * Re-key every track whose dedupKey predates the album.
 *
 * Track keys gained the album (`music:<artist>:<title>` became
 * `track:<artist>:<album>:<title>`). The old key folded a song's studio, live
 * and compilation versions into one group, so deduplicated listings showed one
 * of them. A row still carrying it is re-keyed here rather than staying wrong
 * until a full sync of its server: at startup, and after a restore (a backup
 * taken before the change brings the old keys back).
 *
 * **In place, never through NULL.** Each batch computes the new key and writes
 * it over the old one in one statement. Clearing every legacy key first and
 * re-keying afterwards left whatever a failed batch did not reach — a deadlock
 * with a music sync the worker had started, say — without a key until the next
 * boot: a keyless row is canonical by default, so its copies showed twice, and
 * an exception on one copy stopped protecting the others.
 *
 * **Atomic and retryable per batch.** The key write and the canonical recompute
 * of the groups it touched (the old keys and the new ones) share a transaction,
 * so a batch's keys never land without their flags. The write is
 * compare-and-set on the old key, so a row a concurrent sync re-keyed in
 * between is left alone. A deadlock retries the batch (`withDeadlockRetry`);
 * anything else stops the pass and is returned, never thrown.
 *
 * **Resumable.** The rows themselves are the cursor: each batch selects keys
 * still in the old shape, so the next run picks up exactly what is left.
 */
export async function rekeyLegacyTrackKeys(): Promise<LegacyTrackRekeyResult> {
  let rekeyed = 0;
  try {
    for (;;) {
      const batch = await withDeadlockRetry("rekeyLegacyTrackKeys", rekeyLegacyTrackBatch);
      rekeyed += batch.rekeyed;
      // A short batch was the last one. A full one that moved nothing (every
      // row re-keyed by someone else in between) would only find the same
      // groups again — the next run sees what is left.
      if (batch.groups < LEGACY_TRACK_GROUPS_PER_BATCH || batch.rekeyed === 0) break;
    }
  } catch (error) {
    return { rekeyed, error };
  }
  return { rekeyed };
}

/** One batch of `rekeyLegacyTrackKeys`, in one transaction. */
async function rekeyLegacyTrackBatch(): Promise<{ groups: number; rekeyed: number }> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          title: string;
          parentTitle: string | null;
          albumTitle: string | null;
          dedupKey: string;
          userId: string;
        }[]
      >`SELECT mi."id", mi."title", mi."parentTitle", mi."albumTitle", mi."dedupKey", ms."userId"
          FROM "MediaItem" mi
          JOIN "Library" l ON mi."libraryId" = l."id"
          JOIN "MediaServer" ms ON l."mediaServerId" = ms."id"
         WHERE mi."type" = 'MUSIC'::"LibraryType"
           AND mi."dedupKey" IN (
                 SELECT DISTINCT "dedupKey" FROM "MediaItem"
                  WHERE "type" = 'MUSIC'::"LibraryType"
                    AND "dedupKey" LIKE ${LEGACY_TRACK_DEDUP_KEY_PREFIX + "%"}
                  LIMIT ${LEGACY_TRACK_GROUPS_PER_BATCH}
               )`;
      if (rows.length === 0) return { groups: 0, rekeyed: 0 };

      const ids: string[] = [];
      const oldKeys: string[] = [];
      const newKeys: string[] = [];
      /** Per owner: every group a row left or joined. */
      const touched = new Map<string, Set<string>>();
      for (const row of rows) {
        const key = computeDedupKey("MUSIC", row.title, {
          parentTitle: row.parentTitle,
          albumTitle: row.albumTitle,
        });
        ids.push(row.id);
        oldKeys.push(row.dedupKey);
        newKeys.push(key);
        const groups = touched.get(row.userId) ?? new Set<string>();
        groups.add(row.dedupKey).add(key);
        touched.set(row.userId, groups);
      }

      const rekeyed = await tx.$executeRaw`
        UPDATE "MediaItem" mi SET "dedupKey" = v."newKey"
          FROM unnest(${ids}::text[], ${oldKeys}::text[], ${newKeys}::text[]) AS v("id", "oldKey", "newKey")
         WHERE mi."id" = v."id" AND mi."dedupKey" = v."oldKey"`;

      for (const [userId, groups] of touched) {
        await writeCanonicalFlags(tx, userId, [...groups]);
      }
      return { groups: new Set(oldKeys).size, rekeyed };
    },
    // A batch is a few thousand rows at most; the default 5 s is sized for
    // request paths, not a repair running beside a sync.
    { timeout: 60_000 },
  );
}

/**
 * Repair the keys of rows written before a key's shape changed: a missing
 * `seriesKey`, a track key without the album, a missing `dedupKey`.
 *
 * Runs in the background at startup (never blocking it) and at the end of a
 * restore, since a backup from an earlier version brings the old shapes back.
 * Never throws. Every step resumes from the rows, so whatever a failure leaves
 * is repaired by the next run — and what was done before it is settled now:
 * the canonical copies are recomputed and the media caches dropped even after
 * a failure part-way.
 */
export async function runBackfillIfNeeded(): Promise<void> {
  /** A dedupKey may have changed: cached listings built on the old keys are stale. */
  let keysChanged = false;
  /** A NULL dedupKey may have been filled: every owner's canonical copies need recomputing. */
  let nullKeysFilled = false;
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

    // Recomputes the canonical copies of the groups it touches itself.
    const legacy = await rekeyLegacyTrackKeys();
    if (legacy.rekeyed > 0) keysChanged = true;
    if (legacy.error !== undefined) {
      logger.error(
        "Sync",
        `Re-keying tracks whose dedupKey predates the album stopped after ${legacy.rekeyed} track(s) — ` +
          `the rest keep their old key until the next start or restore re-keys them`,
        { error: String(legacy.error) },
      );
    } else if (legacy.rekeyed > 0) {
      logger.info("Sync", `Re-keyed ${legacy.rekeyed} track(s) whose dedupKey predates the album`);
    }

    const [{ count }] = await prisma.$queryRaw<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM "MediaItem" WHERE "dedupKey" IS NULL LIMIT 1
    `;

    if (count > 0) {
      // Set before the write: a backfill that fails part-way has committed the
      // batches before the failure.
      keysChanged = nullKeysFilled = true;
      logger.info("Sync", `Backfilling dedupKeys for ${count} item(s)...`);
      const updated = await backfillDedupKeys();
      logger.info("Sync", `Backfilled ${updated} dedupKey(s)`);
    }
  } catch (error) {
    logger.error("Sync", "Dedup backfill failed", { error: String(error) });
  }

  try {
    if (nullKeysFilled) {
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
    }
  } catch (error) {
    logger.error("Sync", "Dedup canonical recompute after the backfill failed", { error: String(error) });
  } finally {
    // Runs in the background after boot, so listings and stats may already
    // have cached answers built on the old keys and flags.
    if (keysChanged) invalidateMediaCaches();
  }
}
