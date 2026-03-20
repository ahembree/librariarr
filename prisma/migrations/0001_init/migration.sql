-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MediaServerType" AS ENUM ('PLEX', 'JELLYFIN', 'EMBY');

-- CreateEnum
CREATE TYPE "LibraryType" AS ENUM ('MOVIE', 'SERIES', 'MUSIC');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LifecycleActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('BACKEND', 'API', 'DB');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "plexId" TEXT,
    "plexToken" TEXT,
    "localUsername" TEXT,
    "passwordHash" TEXT,
    "email" TEXT,
    "username" TEXT NOT NULL,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "syncSchedule" TEXT NOT NULL DEFAULT 'DAILY',
    "lastScheduledSync" TIMESTAMP(3),
    "accentColor" TEXT NOT NULL DEFAULT 'default',
    "logRetentionDays" INTEGER NOT NULL DEFAULT 7,
    "lifecycleDetectionSchedule" TEXT NOT NULL DEFAULT 'EVERY_6H',
    "lastScheduledLifecycleDetection" TIMESTAMP(3),
    "lifecycleExecutionSchedule" TEXT NOT NULL DEFAULT 'EVERY_6H',
    "lastScheduledLifecycleExecution" TIMESTAMP(3),
    "dashboardLayout" JSONB,
    "columnPreferences" JSONB,
    "cardDisplayPreferences" JSONB,
    "chipColors" JSONB,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessage" TEXT NOT NULL DEFAULT '',
    "maintenanceDelay" INTEGER NOT NULL DEFAULT 30,
    "transcodeManagerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "transcodeManagerMessage" TEXT NOT NULL DEFAULT '',
    "transcodeManagerDelay" INTEGER NOT NULL DEFAULT 30,
    "transcodeManagerCriteria" JSONB,
    "discordWebhookUrl" TEXT,
    "discordWebhookUsername" TEXT,
    "discordWebhookAvatarUrl" TEXT,
    "discordNotifyMaintenance" BOOLEAN NOT NULL DEFAULT false,
    "localAuthEnabled" BOOLEAN NOT NULL DEFAULT false,
    "preferredTitleServerId" TEXT,
    "preferredArtworkServerId" TEXT,
    "backupSchedule" TEXT NOT NULL DEFAULT 'DAILY',
    "backupRetentionCount" INTEGER NOT NULL DEFAULT 7,
    "backupEncryptionPassword" TEXT,
    "lastBackupAt" TIMESTAMP(3),
    "maintenanceExcludedUsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transcodeManagerExcludedUsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduledJobTime" TEXT NOT NULL DEFAULT '00:00',
    "dedupStats" BOOLEAN NOT NULL DEFAULT true,
    "actionHistoryRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaServer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MediaServerType" NOT NULL DEFAULT 'PLEX',
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "machineId" TEXT,
    "tlsSkipVerify" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SonarrInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "externalUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SonarrInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadarrInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "externalUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadarrInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LidarrInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "externalUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LidarrInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeerrInstance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeerrInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Library" (
    "id" TEXT NOT NULL,
    "mediaServerId" TEXT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "LibraryType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "ratingKey" TEXT NOT NULL,
    "parentRatingKey" TEXT,
    "grandparentRatingKey" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "type" "LibraryType" NOT NULL,
    "summary" TEXT,
    "thumbUrl" TEXT,
    "artUrl" TEXT,
    "parentThumbUrl" TEXT,
    "seasonThumbUrl" TEXT,
    "parentTitle" TEXT,
    "albumTitle" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "contentRating" TEXT,
    "rating" DOUBLE PRECISION,
    "audienceRating" DOUBLE PRECISION,
    "userRating" DOUBLE PRECISION,
    "studio" TEXT,
    "tagline" TEXT,
    "originalTitle" TEXT,
    "originallyAvailableAt" TIMESTAMP(3),
    "viewOffset" INTEGER,
    "genres" JSONB,
    "directors" JSONB,
    "writers" JSONB,
    "roles" JSONB,
    "countries" JSONB,
    "resolution" TEXT,
    "videoWidth" INTEGER,
    "videoHeight" INTEGER,
    "videoCodec" TEXT,
    "videoProfile" TEXT,
    "videoFrameRate" TEXT,
    "videoBitDepth" INTEGER,
    "videoBitrate" INTEGER,
    "videoColorPrimaries" TEXT,
    "videoColorRange" TEXT,
    "videoChromaSubsampling" TEXT,
    "aspectRatio" TEXT,
    "scanType" TEXT,
    "audioCodec" TEXT,
    "audioChannels" INTEGER,
    "audioProfile" TEXT,
    "audioBitrate" INTEGER,
    "audioSamplingRate" INTEGER,
    "container" TEXT,
    "dynamicRange" TEXT,
    "optimizedForStreaming" BOOLEAN,
    "fileSize" BIGINT,
    "filePath" TEXT,
    "duration" INTEGER,
    "titleSort" TEXT,
    "ratingCount" INTEGER,
    "ratingImage" TEXT,
    "audienceRatingImage" TEXT,
    "absoluteIndex" INTEGER,
    "chapterSource" TEXT,
    "labels" JSONB,
    "videoRangeType" TEXT,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedAt" TIMESTAMP(3),
    "addedAt" TIMESTAMP(3),
    "serverUpdatedAt" TIMESTAMP(3),
    "dedupKey" TEXT,
    "dedupCanonical" BOOLEAN NOT NULL DEFAULT true,
    "isWatchlisted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaItemExternalId" (
    "id" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaItemExternalId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaStream" (
    "id" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "streamType" INTEGER NOT NULL,
    "index" INTEGER,
    "codec" TEXT,
    "profile" TEXT,
    "bitrate" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "displayTitle" TEXT,
    "extendedDisplayTitle" TEXT,
    "language" TEXT,
    "languageCode" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "scanType" TEXT,
    "colorPrimaries" TEXT,
    "colorRange" TEXT,
    "chromaSubsampling" TEXT,
    "bitDepth" INTEGER,
    "videoRangeType" TEXT,
    "channels" INTEGER,
    "samplingRate" INTEGER,
    "audioChannelLayout" TEXT,
    "forced" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "mediaServerId" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "currentLibrary" TEXT,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleSet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LibraryType" NOT NULL,
    "rules" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "seriesScope" BOOLEAN NOT NULL DEFAULT true,
    "actionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "actionType" TEXT,
    "actionDelayDays" INTEGER NOT NULL DEFAULT 7,
    "arrInstanceId" TEXT,
    "addImportExclusion" BOOLEAN NOT NULL DEFAULT false,
    "searchAfterDelete" BOOLEAN NOT NULL DEFAULT false,
    "addArrTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removeArrTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionName" TEXT,
    "collectionSortName" TEXT,
    "collectionHomeScreen" BOOLEAN NOT NULL DEFAULT false,
    "collectionRecommended" BOOLEAN NOT NULL DEFAULT false,
    "collectionSort" TEXT NOT NULL DEFAULT 'ALPHABETICAL',
    "discordNotifyOnAction" BOOLEAN NOT NULL DEFAULT false,
    "discordNotifyOnMatch" BOOLEAN NOT NULL DEFAULT false,
    "stickyMatches" BOOLEAN NOT NULL DEFAULT false,
    "serverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaItemId" TEXT,
    "mediaItemTitle" TEXT,
    "mediaItemParentTitle" TEXT,
    "ruleSetId" TEXT,
    "ruleSetName" TEXT,
    "ruleSetType" TEXT,
    "actionType" TEXT NOT NULL,
    "status" "LifecycleActionStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "error" TEXT,
    "arrInstanceId" TEXT,
    "addImportExclusion" BOOLEAN NOT NULL DEFAULT false,
    "searchAfterDelete" BOOLEAN NOT NULL DEFAULT false,
    "matchedMediaItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addArrTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removeArrTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalMediaId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleMatch" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "itemData" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleException" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "plexClientId" TEXT NOT NULL,
    "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "category" "LogCategory" NOT NULL DEFAULT 'BACKEND',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackoutSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleType" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "daysOfWeek" JSONB,
    "startTime" TEXT,
    "endTime" TEXT,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT 'Stream terminated due to scheduled blackout period.',
    "delay" INTEGER NOT NULL DEFAULT 30,
    "excludedUsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlackoutSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrerollPreset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrerollPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrerollSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "prerollPath" TEXT NOT NULL,
    "scheduleType" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "daysOfWeek" JSONB,
    "startTime" TEXT,
    "endTime" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrerollSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedQuery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchHistory" (
    "id" TEXT NOT NULL,
    "mediaItemId" TEXT NOT NULL,
    "mediaServerId" TEXT NOT NULL,
    "serverUsername" TEXT NOT NULL,
    "watchedAt" TIMESTAMP(3),
    "deviceName" TEXT,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_plexId_key" ON "User"("plexId");

-- CreateIndex
CREATE UNIQUE INDEX "User_localUsername_key" ON "User"("localUsername");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_userId_key" ON "AppSettings"("userId");

-- CreateIndex
CREATE INDEX "SonarrInstance_userId_idx" ON "SonarrInstance"("userId");

-- CreateIndex
CREATE INDEX "RadarrInstance_userId_idx" ON "RadarrInstance"("userId");

-- CreateIndex
CREATE INDEX "LidarrInstance_userId_idx" ON "LidarrInstance"("userId");

-- CreateIndex
CREATE INDEX "SeerrInstance_userId_idx" ON "SeerrInstance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Library_mediaServerId_key_key" ON "Library"("mediaServerId", "key");

-- CreateIndex
CREATE INDEX "MediaItem_type_idx" ON "MediaItem"("type");

-- CreateIndex
CREATE INDEX "MediaItem_type_title_idx" ON "MediaItem"("type", "title");

-- CreateIndex
CREATE INDEX "MediaItem_dedupKey_idx" ON "MediaItem"("dedupKey");

-- CreateIndex
CREATE INDEX "MediaItem_type_dedupCanonical_title_idx" ON "MediaItem"("type", "dedupCanonical", "title");

-- CreateIndex
CREATE INDEX "MediaItem_resolution_idx" ON "MediaItem"("resolution");

-- CreateIndex
CREATE INDEX "MediaItem_playCount_idx" ON "MediaItem"("playCount");

-- CreateIndex
CREATE INDEX "MediaItem_lastPlayedAt_idx" ON "MediaItem"("lastPlayedAt");

-- CreateIndex
CREATE INDEX "MediaItem_parentTitle_idx" ON "MediaItem"("parentTitle");

-- CreateIndex
CREATE INDEX "MediaItem_albumTitle_idx" ON "MediaItem"("albumTitle");

-- CreateIndex
CREATE INDEX "MediaItem_contentRating_idx" ON "MediaItem"("contentRating");

-- CreateIndex
CREATE INDEX "MediaItem_studio_idx" ON "MediaItem"("studio");

-- CreateIndex
CREATE INDEX "MediaItem_addedAt_idx" ON "MediaItem"("addedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaItem_libraryId_ratingKey_key" ON "MediaItem"("libraryId", "ratingKey");

-- CreateIndex
CREATE INDEX "MediaItemExternalId_source_externalId_idx" ON "MediaItemExternalId"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaItemExternalId_mediaItemId_source_key" ON "MediaItemExternalId"("mediaItemId", "source");

-- CreateIndex
CREATE INDEX "MediaStream_mediaItemId_idx" ON "MediaStream"("mediaItemId");

-- CreateIndex
CREATE INDEX "MediaStream_mediaItemId_streamType_idx" ON "MediaStream"("mediaItemId", "streamType");

-- CreateIndex
CREATE INDEX "SyncJob_mediaServerId_status_idx" ON "SyncJob"("mediaServerId", "status");

-- CreateIndex
CREATE INDEX "LifecycleAction_status_scheduledFor_idx" ON "LifecycleAction"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "RuleMatch_ruleSetId_idx" ON "RuleMatch"("ruleSetId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleMatch_ruleSetId_mediaItemId_key" ON "RuleMatch"("ruleSetId", "mediaItemId");

-- CreateIndex
CREATE INDEX "LifecycleException_userId_idx" ON "LifecycleException"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LifecycleException_userId_mediaItemId_key" ON "LifecycleException"("userId", "mediaItemId");

-- CreateIndex
CREATE INDEX "LogEntry_level_idx" ON "LogEntry"("level");

-- CreateIndex
CREATE INDEX "LogEntry_category_idx" ON "LogEntry"("category");

-- CreateIndex
CREATE INDEX "LogEntry_source_idx" ON "LogEntry"("source");

-- CreateIndex
CREATE INDEX "LogEntry_createdAt_idx" ON "LogEntry"("createdAt");

-- CreateIndex
CREATE INDEX "BlackoutSchedule_userId_idx" ON "BlackoutSchedule"("userId");

-- CreateIndex
CREATE INDEX "BlackoutSchedule_enabled_idx" ON "BlackoutSchedule"("enabled");

-- CreateIndex
CREATE INDEX "PrerollPreset_userId_idx" ON "PrerollPreset"("userId");

-- CreateIndex
CREATE INDEX "PrerollSchedule_userId_idx" ON "PrerollSchedule"("userId");

-- CreateIndex
CREATE INDEX "PrerollSchedule_enabled_idx" ON "PrerollSchedule"("enabled");

-- CreateIndex
CREATE INDEX "SavedQuery_userId_idx" ON "SavedQuery"("userId");

-- CreateIndex
CREATE INDEX "WatchHistory_mediaItemId_idx" ON "WatchHistory"("mediaItemId");

-- CreateIndex
CREATE INDEX "WatchHistory_mediaServerId_idx" ON "WatchHistory"("mediaServerId");

-- CreateIndex
CREATE INDEX "WatchHistory_serverUsername_idx" ON "WatchHistory"("serverUsername");

-- CreateIndex
CREATE INDEX "WatchHistory_watchedAt_idx" ON "WatchHistory"("watchedAt");

-- CreateIndex
CREATE INDEX "WatchHistory_deviceName_idx" ON "WatchHistory"("deviceName");

-- CreateIndex
CREATE INDEX "WatchHistory_platform_idx" ON "WatchHistory"("platform");

-- AddForeignKey
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaServer" ADD CONSTRAINT "MediaServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SonarrInstance" ADD CONSTRAINT "SonarrInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RadarrInstance" ADD CONSTRAINT "RadarrInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LidarrInstance" ADD CONSTRAINT "LidarrInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeerrInstance" ADD CONSTRAINT "SeerrInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Library" ADD CONSTRAINT "Library_mediaServerId_fkey" FOREIGN KEY ("mediaServerId") REFERENCES "MediaServer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaItemExternalId" ADD CONSTRAINT "MediaItemExternalId_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaStream" ADD CONSTRAINT "MediaStream_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_mediaServerId_fkey" FOREIGN KEY ("mediaServerId") REFERENCES "MediaServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSet" ADD CONSTRAINT "RuleSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleMatch" ADD CONSTRAINT "RuleMatch_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleMatch" ADD CONSTRAINT "RuleMatch_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleException" ADD CONSTRAINT "LifecycleException_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleException" ADD CONSTRAINT "LifecycleException_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackoutSchedule" ADD CONSTRAINT "BlackoutSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrerollPreset" ADD CONSTRAINT "PrerollPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrerollSchedule" ADD CONSTRAINT "PrerollSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedQuery" ADD CONSTRAINT "SavedQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_mediaServerId_fkey" FOREIGN KEY ("mediaServerId") REFERENCES "MediaServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

