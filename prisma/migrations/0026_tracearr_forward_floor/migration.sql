-- How far back the next forward Tracearr pass must reach. A forward walk goes
-- newest -> oldest, so one that commits a page and then stops moves the forward
-- watermark (MAX("watchedAt")) past plays it never read; the next run's window,
-- derived from that watermark, started above them and they were never
-- imported. Recorded when such a walk stops and cleared once a forward walk
-- covers its whole window. Null for every existing server: nothing records
-- whether an earlier forward walk was interrupted.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardFloorAt" TIMESTAMP(3);

-- When a backfill walk last ran for the current mapping (exhausted or stopped
-- at its slice). Null until the first walk, and reset whenever the walk is
-- restarted or the mapping changes, so the status readout can tell a mapping
-- that has never been walked from one whose walk found nothing to import.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillLastWalkAt" TIMESTAMP(3);

-- The importer no longer infers stale walk state from "no Tracearr rows" (that
-- re-walked an archive that legitimately stored nothing, forever); the paths
-- that destroy rows now reset the state explicitly. State left behind before
-- this release by a path that did not (a config-only restore, a purge) is
-- reset once here, so such a server walks its archive from the newest play
-- one more time rather than staying "complete" with nothing imported.
UPDATE "MediaServer" ms
   SET "tracearrBackfillComplete" = false,
       "tracearrBackfillCursorAt" = NULL,
       "tracearrForwardFloorAt" = NULL
 WHERE ms."tracearrServerId" IS NOT NULL
   AND (ms."tracearrBackfillComplete" OR ms."tracearrBackfillCursorAt" IS NOT NULL
        OR ms."tracearrForwardFloorAt" IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM "WatchHistory" wh
      WHERE wh."mediaServerId" = ms."id" AND wh."source" = 'TRACEARR'
   );

-- Servers whose walk has demonstrably run already: complete, or holding a
-- resume cursor.
UPDATE "MediaServer"
   SET "tracearrBackfillLastWalkAt" = CURRENT_TIMESTAMP
 WHERE "tracearrServerId" IS NOT NULL
   AND ("tracearrBackfillComplete" OR "tracearrBackfillCursorAt" IS NOT NULL);
