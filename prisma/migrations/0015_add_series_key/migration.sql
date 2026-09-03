-- Series identity key. Librariarr stores episodes, not shows, so "which show
-- does this episode belong to" is derived. Keying that on parentTitle collapsed
-- two different shows that share a title (The Office UK/US, Battlestar Galactica
-- 1978/2004) into one series everywhere — one library row, blended seasons, and
-- blended episodeCount / watchedEpisodePercentage / seriesLastPlayedAt feeding
-- destructive lifecycle rules. seriesKey keys on the SERIES-level external ids
-- every episode already stores instead: "tvdb:<id>", else "tmdb:<id>", else the
-- old "title:<lower(trim(parentTitle))>" fallback. Same show on two servers
-- still merges (shared TVDB id); two same-titled shows separate (distinct ids).
-- Not keyed on grandparentRatingKey — that is per-server and would split a show
-- across servers.

-- AlterTable
ALTER TABLE "MediaItem" ADD COLUMN "seriesKey" TEXT;

-- Backfill existing SERIES rows from their persisted show-level external ids,
-- mirroring src/lib/media/series-key.ts (keep the two in lockstep). Movies and
-- tracks keep seriesKey NULL. Blank ids/titles fall through to the next branch.
UPDATE "MediaItem" mi
SET "seriesKey" = COALESCE(
    (SELECT 'tvdb:' || NULLIF(TRIM(e."externalId"), '')
        FROM "MediaItemExternalId" e
       WHERE e."mediaItemId" = mi."id"
         AND UPPER(e."source") = 'TVDB'
         AND NULLIF(TRIM(e."externalId"), '') IS NOT NULL
       LIMIT 1),
    (SELECT 'tmdb:' || NULLIF(TRIM(e."externalId"), '')
        FROM "MediaItemExternalId" e
       WHERE e."mediaItemId" = mi."id"
         AND UPPER(e."source") = 'TMDB'
         AND NULLIF(TRIM(e."externalId"), '') IS NOT NULL
       LIMIT 1),
    'title:' || NULLIF(LOWER(TRIM(mi."parentTitle")), '')
  )
WHERE mi."type" = 'SERIES'::"LibraryType";

-- CreateIndex
CREATE INDEX "MediaItem_type_seriesKey_idx" ON "MediaItem"("type", "seriesKey");
