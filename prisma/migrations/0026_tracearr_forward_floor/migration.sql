-- How far back the next forward Tracearr pass must reach. A forward walk goes
-- newest -> oldest, so one that commits a page and then stops moves the forward
-- watermark (MAX("watchedAt")) past plays it never read; the next run's window,
-- derived from that watermark, started above them and they were never
-- imported. Recorded when such a walk stops and cleared once a forward walk
-- covers its whole window. Null for every existing server: nothing records
-- whether an earlier forward walk was interrupted.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardFloorAt" TIMESTAMP(3);

-- The start of the newest forward walk that recorded the forward floor. A walk
-- may clear the floor only if this is no later than its own start: a walk that
-- started later can have left plays newer than that start unread.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardFloorRecordedAt" TIMESTAMP(3);

-- When a backfill walk last ran for the current mapping (exhausted or stopped
-- at its slice). Null until the first walk, and reset whenever the walk is
-- restarted or the mapping changes, so the status readout can tell a mapping
-- that has never been walked from one whose walk found nothing to import.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillLastWalkAt" TIMESTAMP(3);

-- Set while some of the server's media rows are known to be missing and only a
-- complete library sync brings them back (a bulk delete, a restore, a library
-- being populated for the first time). While set, play history cannot be
-- re-established for the server and a Tracearr archive walk is held. Null for
-- every existing server, except the restart-shaped ones fixed up below.
ALTER TABLE "MediaServer" ADD COLUMN "libraryResyncRequiredAt" TIMESTAMP(3);

-- Bumped on every change of "tracearrServerId", so an import that started
-- before an unlink-and-relink to the same Tracearr server cannot write over
-- the reset the relink made.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrMappingVersion" INTEGER NOT NULL DEFAULT 0;

-- For a mapping with no stored Tracearr rows: the instant every older play is
-- known to have been read, which the forward pass resumes from. Null for every
-- existing server: the data fixes below leave no such server needing one (a
-- server with no Tracearr rows is reset to a fresh walk).
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardWatermarkAt" TIMESTAMP(3);

-- When a library's last pass ended short within the release tolerance while
-- its server was held for a library resync; the second such pass in a row
-- counts as synced. Null for every existing library.
ALTER TABLE "Library" ADD COLUMN "shortPassSeenAt" TIMESTAMP(3);

-- When detection last skipped a rule set because its servers' play history was
-- not established, until detection evaluates it again: its matches predate
-- that refusal, so its actions stay held until they are re-evaluated. Null for
-- every existing rule set.
ALTER TABLE "RuleSet" ADD COLUMN "playHistoryPausedAt" TIMESTAMP(3);

-- A native play filed against two library copies of one Jellyfin/Emby item is
-- stored once per copy; the second row points at the copy that holds the
-- primary row, so lists of plays show it once. Null for every existing row.
ALTER TABLE "WatchHistory" ADD COLUMN "fanOutOfItemId" TEXT;
CREATE INDEX "WatchHistory_fanOutOfItemId_idx" ON "WatchHistory"("fanOutOfItemId");
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_fanOutOfItemId_fkey" FOREIGN KEY ("fanOutOfItemId") REFERENCES "MediaItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
-- resume cursor. UTC, as Prisma reads these columns: CURRENT_TIMESTAMP alone
-- is written in the session's time zone, which is local time on a database
-- whose TimeZone is not UTC (as in 0024).
UPDATE "MediaServer"
   SET "tracearrBackfillLastWalkAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
 WHERE "tracearrServerId" IS NOT NULL
   AND ("tracearrBackfillComplete" OR "tracearrBackfillCursorAt" IS NOT NULL);

-- A walk restarted before this release (a purge, disable-with-delete) moved its
-- resume cursor to the restart instant, which is newer than every play it had
-- imported — a walk in progress never has its cursor above its newest row. Such
-- a server is still waiting for the library sync that re-adds the deleted
-- items, so it gets the hold that release records explicitly, and is not
-- "walked" yet (the UPDATE above stamped it, since it holds a cursor). The
-- hold is the restart instant itself, as requireLibraryResync records one: a
-- release waits only for the libraries holding no item created before the
-- hold, which are the ones the purge emptied.
UPDATE "MediaServer" ms
   SET "libraryResyncRequiredAt" = ms."tracearrBackfillCursorAt",
       "tracearrBackfillLastWalkAt" = NULL,
       "tracearrForwardWatermarkAt" = ms."tracearrBackfillCursorAt"
 WHERE ms."tracearrServerId" IS NOT NULL
   AND NOT ms."tracearrBackfillComplete"
   AND ms."tracearrBackfillCursorAt" IS NOT NULL
   AND ms."tracearrBackfillCursorAt" > (
     SELECT MAX(wh."watchedAt") FROM "WatchHistory" wh
      WHERE wh."mediaServerId" = ms."id" AND wh."source" = 'TRACEARR'
   );

-- On Jellyfin/Emby two libraries over one folder list the same item under one
-- id, and a Tracearr play of such an item is now filed against every copy.
-- Before this release the import skipped such a play as ambiguous, or stored
-- it on the one copy that existed then, and a walk already past those plays
-- never reads them again. So every mapped Jellyfin/Emby server holding such
-- copies whose walk has started (complete, holding a resume cursor, or holding
-- Tracearr rows: a first slice that died after committing pages left no
-- cursor) walks its archive again from the newest play
-- (the state a walk restart writes), with play-activity rules paused until it
-- finishes. After the restart-shaped fix above, so it does not read this
-- restart as one of those and hold the server.
UPDATE "MediaServer" ms
   SET "tracearrBackfillComplete" = false,
       "tracearrBackfillCursorAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
       "tracearrForwardWatermarkAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
       "tracearrForwardFloorAt" = NULL,
       "tracearrForwardFloorRecordedAt" = NULL,
       "tracearrBackfillLastWalkAt" = NULL
 WHERE ms."tracearrServerId" IS NOT NULL
   AND ms."type" IN ('JELLYFIN', 'EMBY')
   AND (ms."tracearrBackfillComplete" OR ms."tracearrBackfillCursorAt" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM "WatchHistory" wh
           WHERE wh."mediaServerId" = ms."id" AND wh."source" = 'TRACEARR'
        ))
   AND EXISTS (
     SELECT 1
       FROM "MediaItem" a
       JOIN "Library" la ON la."id" = a."libraryId"
       JOIN "MediaItem" b ON b."ratingKey" = a."ratingKey" AND b."libraryId" <> a."libraryId"
       JOIN "Library" lb ON lb."id" = b."libraryId"
      WHERE la."mediaServerId" = ms."id" AND lb."mediaServerId" = ms."id"
   );
