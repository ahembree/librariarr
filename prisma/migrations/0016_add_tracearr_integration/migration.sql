-- Tracearr integration: instance CRUD, the per-server link, and the rich
-- play-session columns on WatchHistory.

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
