-- Tracearr integration: instance CRUD, the per-server link, the rich
-- play-session columns on WatchHistory, and the backfill/evidence state that
-- gates play-activity lifecycle rules on a server's watch history.

-- CreateTable
CREATE TABLE "TracearrInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TracearrInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TracearrInstance_userId_idx" ON "TracearrInstance"("userId");

-- AddForeignKey
ALTER TABLE "TracearrInstance" ADD CONSTRAINT "TracearrInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: link a media server to at most one Tracearr server (null = native history)
ALTER TABLE "MediaServer" ADD COLUMN "tracearrServerId" TEXT;

-- AlterTable: one-time archive-backfill progress. Tracearr returns history
-- newest-first, so the forward watermark (MAX("watchedAt")) is established by
-- the first page imported and cannot express "how far back have we got" -- an
-- import interrupted partway would otherwise resume from the newest play and
-- silently abandon all older history.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillComplete" BOOLEAN NOT NULL DEFAULT false;

-- The oldest play Tracearr holds for this server, measured once by bisecting
-- the `until` filter. Gives the backfill a determinate progress figure: the
-- walk is complete exactly when it reaches this instant. A record-count
-- figure is not available (no total on the keyset API) and would not be
-- honest anyway, since plays whose media has left the library are
-- deliberately not stored.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrOldestPlayAt" TIMESTAMP(3);

-- How far back the backfill has WALKED, which is not the same as how far back
-- it has stored rows. Resuming from MIN("watchedAt") over stored rows only
-- advances when a record was importable, and plays whose media has left the
-- library are deliberately not stored -- so a contiguous unstorable stretch
-- longer than one slice would be re-walked forever. Recording what was seen
-- guarantees progress.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillCursorAt" TIMESTAMP(3);

-- When a sync last established what was played on this server. A null means
-- "we do not know" -- the safe default for a column that gates destructive
-- play-activity lifecycle rules, covering both a brand-new server and one
-- whose watch history was just cleared by a source switch, a purge, or a
-- restore.
ALTER TABLE "MediaServer" ADD COLUMN "watchHistorySyncedAt" TIMESTAMP(3);

-- AlterTable: rich play-session detail. Every column is nullable except
-- "source", whose DEFAULT correctly tags all pre-existing rows as NATIVE.
ALTER TABLE "WatchHistory" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'NATIVE';
ALTER TABLE "WatchHistory" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "referenceId" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "watched" BOOLEAN;
ALTER TABLE "WatchHistory" ADD COLUMN "percentComplete" DOUBLE PRECISION;
ALTER TABLE "WatchHistory" ADD COLUMN "state" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "progressMs" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "totalDurationMs" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "segmentCount" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "stoppedAt" TIMESTAMP(3);
ALTER TABLE "WatchHistory" ADD COLUMN "player" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "product" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "isTranscode" BOOLEAN;
ALTER TABLE "WatchHistory" ADD COLUMN "videoDecision" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "audioDecision" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "bitrate" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "resolution" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceVideoCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceAudioCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamVideoCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamAudioCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "transcodeInfo" JSONB;
ALTER TABLE "WatchHistory" ADD COLUMN "subtitleInfo" JSONB;
ALTER TABLE "WatchHistory" ADD COLUMN "streamQuality" JSONB;

-- CreateIndex: dedup key for the Tracearr append/upsert path. Native rows leave
-- "sourceEventId" NULL and Postgres treats NULLs as distinct, so they never collide.
CREATE UNIQUE INDEX "WatchHistory_mediaServerId_sourceEventId_key" ON "WatchHistory"("mediaServerId", "sourceEventId");

-- CreateIndex: the columns the watch-history UI filters and sorts on.
CREATE INDEX "WatchHistory_source_idx" ON "WatchHistory"("source");
CREATE INDEX "WatchHistory_watched_idx" ON "WatchHistory"("watched");
CREATE INDEX "WatchHistory_isTranscode_idx" ON "WatchHistory"("isTranscode");
CREATE INDEX "WatchHistory_player_idx" ON "WatchHistory"("player");
CREATE INDEX "WatchHistory_resolution_idx" ON "WatchHistory"("resolution");

-- A server currently holding watch history has demonstrably had it
-- established; everything else stays null and is established by its next
-- successful sync, which pauses play-activity rules for that server until then.
UPDATE "MediaServer" ms
   SET "watchHistorySyncedAt" = NOW()
 WHERE EXISTS (
       SELECT 1 FROM "WatchHistory" wh WHERE wh."mediaServerId" = ms."id"
     );
