import { prisma } from "@/lib/db";

/**
 * Writes every track's artist id in one statement, for a server whose track
 * listings do not carry it (Plex). Set-based over the whole library because the
 * full sync skips the upsert for tracks Plex reports unchanged, so a per-item
 * write would never reach the tracks already stored. A track whose artist has
 * no MusicBrainz id loses a stale one.
 */
export async function writeArtistMbids(
  libraryId: string,
  artistMbids: Map<string, string>,
): Promise<void> {
  const keys = [...artistMbids.keys()];
  const ids = keys.map((k) => artistMbids.get(k)!);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MediaItemExternalId" ("id","mediaItemId","source","externalId","createdAt")
     SELECT gen_random_uuid()::text, mi."id", 'MUSICBRAINZ', m.mbid, NOW()
     FROM "MediaItem" mi
     JOIN unnest($2::text[], $3::text[]) AS m(rk, mbid) ON mi."grandparentRatingKey" = m.rk
     WHERE mi."libraryId" = $1 AND mi."type" = 'MUSIC'
     ON CONFLICT ("mediaItemId","source") DO UPDATE SET "externalId" = EXCLUDED."externalId"
     WHERE "MediaItemExternalId"."externalId" IS DISTINCT FROM EXCLUDED."externalId"`,
    libraryId, keys, ids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "MediaItemExternalId" e
     USING "MediaItem" mi
     WHERE e."mediaItemId" = mi."id" AND e."source" = 'MUSICBRAINZ'
       AND mi."libraryId" = $1 AND mi."type" = 'MUSIC'
       AND (mi."grandparentRatingKey" IS NULL OR NOT (mi."grandparentRatingKey" = ANY($2::text[])))`,
    libraryId, keys,
  );
}
