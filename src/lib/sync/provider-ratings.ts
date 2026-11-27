import type { Prisma } from "@/generated/prisma/client";

/**
 * Plex's per-provider ratings (`imdbRating`, `tmdbRating`, `rtCriticRating`,
 * `rtAudienceRating`) come only from an item's detail response, which a full
 * sync fetches only when Plex's `updatedAt` differs from the stored
 * `serverUpdatedAt`. A stored row that predates the columns would therefore
 * never fill them: its `serverUpdatedAt` is cleared so the next full sync reads
 * it once. Until then the row is PENDING, and criteria reading the ratings
 * wait for it (`countPendingProviderRatings`, lifecycle/evaluability.ts).
 */

/** Rows a Plex sync must read again for their ratings: Plex movies and episodes. */
const PLEX_RATED_ROWS = `
  FROM "Library" l
  JOIN "MediaServer" s ON s."id" = l."mediaServerId"
 WHERE mi."libraryId" = l."id"
   AND s."type" = 'PLEX'
   AND mi."type" IN ('MOVIE', 'SERIES')`;

/**
 * Clears `serverUpdatedAt` on every Plex movie and episode, so the next full
 * sync re-reads each one and fills its ratings — what migration
 * `0035_external_ratings` did on upgrade, for rows that arrive later without
 * them (a full backup taken before that version, restored). Returns the rows
 * queued.
 */
export function requeueProviderRatings(client: Prisma.TransactionClient): Promise<number> {
  return client.$executeRawUnsafe(
    `UPDATE "MediaItem" mi SET "serverUpdatedAt" = NULL ${PLEX_RATED_ROWS} AND mi."serverUpdatedAt" IS NOT NULL`,
  );
}

/** Whether restored `MediaItem` rows come from a backup taken before the ratings existed. */
export function rowsPredateProviderRatings(rows: readonly unknown[]): boolean {
  return rows.some((row) => typeof row === "object" && row !== null && !("imdbRating" in row));
}

/**
 * Per enabled Plex server, how many of its movies or episodes (`types`) in an
 * enabled library still wait for a full sync to read their ratings — a row
 * with no `serverUpdatedAt`: queued by the migration or a restore, or a new
 * item whose detail fetch failed. Every enabled Plex server counts, whatever
 * servers the caller evaluates: a Jellyfin/Emby copy reads its Plex copy's
 * ratings (`mirrorProviderRatings`), so it is only as complete as Plex.
 */
export async function countPendingProviderRatings(
  client: Prisma.TransactionClient,
  userId: string,
  types: ReadonlyArray<"MOVIE" | "SERIES">,
): Promise<Array<{ name: string; pending: number }>> {
  if (types.length === 0) return [];
  const rows = await client.$queryRawUnsafe<Array<{ name: string; pending: bigint }>>(
    `SELECT s."name", COUNT(*) AS "pending"
       FROM "MediaItem" mi
       JOIN "Library" l ON l."id" = mi."libraryId"
       JOIN "MediaServer" s ON s."id" = l."mediaServerId"
      WHERE s."userId" = $1 AND s."enabled" AND s."type" = 'PLEX' AND l."enabled"
        AND mi."type"::text = ANY($2::text[])
        AND mi."serverUpdatedAt" IS NULL
      GROUP BY s."id", s."name"
      ORDER BY s."name"`,
    userId,
    [...types],
  );
  return rows.map((r) => ({ name: r.name, pending: Number(r.pending) }));
}
