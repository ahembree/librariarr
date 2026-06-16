-- CreateTable: TautulliInstance
CREATE TABLE "TautulliInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaServerId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TautulliInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TautulliInstance_userId_idx" ON "TautulliInstance"("userId");
CREATE INDEX "TautulliInstance_mediaServerId_idx" ON "TautulliInstance"("mediaServerId");

ALTER TABLE "TautulliInstance" ADD CONSTRAINT "TautulliInstance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TautulliInstance" ADD CONSTRAINT "TautulliInstance_mediaServerId_fkey"
  FOREIGN KEY ("mediaServerId") REFERENCES "MediaServer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: WatchHistory — provenance / idempotency
ALTER TABLE "WatchHistory" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PLEX';
ALTER TABLE "WatchHistory" ADD COLUMN "serverHistoryKey" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "tautulliRowId" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "tautulliReferenceId" TEXT;

-- AlterTable: WatchHistory — session / engagement
ALTER TABLE "WatchHistory" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "WatchHistory" ADD COLUMN "stoppedAt" TIMESTAMP(3);
ALTER TABLE "WatchHistory" ADD COLUMN "playDurationSec" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "pausedCounter" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "percentComplete" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "location" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "player" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "product" TEXT;

-- AlterTable: WatchHistory — transcode decision
ALTER TABLE "WatchHistory" ADD COLUMN "transcodeDecision" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "videoDecision" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "audioDecision" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "subtitleDecision" TEXT;

-- AlterTable: WatchHistory — source (on-disk) tracks
ALTER TABLE "WatchHistory" ADD COLUMN "sourceVideoCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceAudioCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceContainer" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceVideoResolution" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "sourceVideoDynamicRange" TEXT;

-- AlterTable: WatchHistory — delivered stream
ALTER TABLE "WatchHistory" ADD COLUMN "streamVideoCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamAudioCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamContainer" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamSubtitleCodec" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamVideoResolution" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "streamVideoBitrate" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "streamAudioBitrate" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "streamBitrate" INTEGER;
ALTER TABLE "WatchHistory" ADD COLUMN "streamVideoDynamicRange" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "transcodeHwDecode" TEXT;
ALTER TABLE "WatchHistory" ADD COLUMN "transcodeHwEncode" TEXT;

-- Indexes for new columns
CREATE INDEX "WatchHistory_source_idx" ON "WatchHistory"("source");
CREATE INDEX "WatchHistory_transcodeDecision_idx" ON "WatchHistory"("transcodeDecision");

-- Unique provenance keys (NULLs are distinct in Postgres, so single-source rows coexist)
CREATE UNIQUE INDEX "WatchHistory_mediaServerId_serverHistoryKey_key" ON "WatchHistory"("mediaServerId", "serverHistoryKey");
CREATE UNIQUE INDEX "WatchHistory_mediaServerId_tautulliRowId_key" ON "WatchHistory"("mediaServerId", "tautulliRowId");
