import { prisma } from "@/lib/db";

export interface StoredMatch {
  ruleSetId: string;
  mediaItemId: string;
  /** The snapshot detection stored — whole, or only the keys asked for. */
  itemData: Record<string, unknown> | null;
}

/**
 * The stored matches of some rule sets, with only the top-level keys of each
 * `itemData` snapshot a caller reads (`keys`), or the whole snapshot when
 * `keys` is null.
 *
 * A snapshot is the matched item's full row — summary, genres, credits,
 * streams — about 2 KB, of which detection's bookkeeping reads a few ids and
 * titles. Taking only those keys in SQL (`jsonb_each` over the object, so a key
 * the snapshot lacks stays absent, exactly as it reads in the whole snapshot)
 * spares reading and parsing the rest for every match a run already holds.
 * A snapshot that is not a JSON object is returned as it is.
 */
export async function loadStoredMatches(
  ruleSetIds: readonly string[],
  keys: readonly string[] | null,
): Promise<StoredMatch[]> {
  if (ruleSetIds.length === 0) return [];
  if (keys === null) {
    return prisma.$queryRawUnsafe<StoredMatch[]>(
      `SELECT "ruleSetId", "mediaItemId", "itemData" FROM "RuleMatch" WHERE "ruleSetId" = ANY($1::text[])`,
      [...ruleSetIds],
    );
  }
  return prisma.$queryRawUnsafe<StoredMatch[]>(
    `SELECT "ruleSetId", "mediaItemId",
            CASE WHEN jsonb_typeof("itemData") = 'object'
                 THEN COALESCE(
                        (SELECT jsonb_object_agg(e.key, e.value)
                           FROM jsonb_each("itemData") e
                          WHERE e.key = ANY($2::text[])),
                        '{}'::jsonb)
                 ELSE "itemData"
            END AS "itemData"
       FROM "RuleMatch"
      WHERE "ruleSetId" = ANY($1::text[])`,
    [...ruleSetIds],
    [...keys],
  );
}

/** Each stored match's `itemData.memberIds`, and nothing else of the snapshot. */
export async function loadStoredMatchMembers(
  ruleSetIds: readonly string[],
): Promise<Array<{ ruleSetId: string; mediaItemId: string; memberIds: unknown }>> {
  if (ruleSetIds.length === 0) return [];
  return prisma.$queryRawUnsafe(
    `SELECT "ruleSetId", "mediaItemId", "itemData"->'memberIds' AS "memberIds"
       FROM "RuleMatch"
      WHERE "ruleSetId" = ANY($1::text[])`,
    [...ruleSetIds],
  );
}
