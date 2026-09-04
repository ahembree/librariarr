-- Invert the watch-history evidence marker.
--
-- `watchHistoryClearedAt` recorded when history was destroyed, which cannot
-- express the state that matters most: a server whose history has NEVER been
-- established. Its null default read as "fine", so a brand-new server — or one
-- whose items were recreated by a purge or a restore — presented an empty
-- WatchHistory as though it were evidence that nothing had been watched. Every
-- play-activity criterion goes vacuously true against that, and on a DELETE
-- rule set that is the whole library.
--
-- `watchHistorySyncedAt` asks the question the other way round: when did a sync
-- last establish what was played here? A null then correctly means "we do not
-- know", which is the safe default for a column that gates destructive rules.
ALTER TABLE "MediaServer" RENAME COLUMN "watchHistoryClearedAt" TO "watchHistorySyncedAt";

-- The rename inverts the meaning of existing values, so reset them all and then
-- re-establish only what the rows can actually vouch for: a server currently
-- holding watch history has demonstrably had it established. Everything else
-- stays null and is re-established by its next successful sync, which pauses
-- play-activity rules for that server until then.
UPDATE "MediaServer" SET "watchHistorySyncedAt" = NULL;

UPDATE "MediaServer" ms
   SET "watchHistorySyncedAt" = NOW()
 WHERE EXISTS (
       SELECT 1 FROM "WatchHistory" wh WHERE wh."mediaServerId" = ms."id"
     );
