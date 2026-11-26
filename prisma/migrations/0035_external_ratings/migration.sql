-- Each provider's score from Plex's `Rating` array: IMDb and TMDB (0–10) and
-- Rotten Tomatoes critic and audience (0–100).
ALTER TABLE "MediaItem" ADD COLUMN "imdbRating" DOUBLE PRECISION;
ALTER TABLE "MediaItem" ADD COLUMN "tmdbRating" DOUBLE PRECISION;
ALTER TABLE "MediaItem" ADD COLUMN "rtCriticRating" DOUBLE PRECISION;
ALTER TABLE "MediaItem" ADD COLUMN "rtAudienceRating" DOUBLE PRECISION;

-- A full Plex sync re-fetches an item's details only when Plex's `updatedAt`
-- differs from the stored `serverUpdatedAt`, so items already stored would
-- never fill the new columns. Clearing it on Plex movies and episodes makes
-- the next full sync re-fetch them once.
UPDATE "MediaItem" mi
SET "serverUpdatedAt" = NULL
FROM "Library" l
JOIN "MediaServer" s ON s."id" = l."mediaServerId"
WHERE mi."libraryId" = l."id"
  AND s."type" = 'PLEX'
  AND mi."type" IN ('MOVIE', 'SERIES');
