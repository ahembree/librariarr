-- A lifecycle action on ONE episode of a series (a file delete that matched a
-- single episode, or a Query-page action on an individual episode) is named
-- "<Show> SxxExx". Its history row keeps the show's title, but nothing kept the
-- season and episode numbers, so once the episode's MediaItem row is purged
-- after the delete the row could only say which show it was. Actions record
-- them from here on.
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemSeasonNumber" INTEGER;
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemEpisodeNumber" INTEGER;

-- Record them now for every such action whose episode still exists, so a purge
-- from here on does not lose them: a Sonarr file delete whose only targeted
-- episode is the one it is stored against (see actionTitleSnapshot).
UPDATE "LifecycleAction" AS la
SET "mediaItemSeasonNumber" = mi."seasonNumber",
    "mediaItemEpisodeNumber" = mi."episodeNumber"
FROM "MediaItem" AS mi
WHERE mi."id" = la."mediaItemId"
  AND mi."type" = 'SERIES'
  AND la."actionType" IN ('DELETE_FILES_SONARR', 'UNMONITOR_DELETE_FILES_SONARR', 'MONITOR_DELETE_FILES_SONARR')
  AND la."matchedMediaItemIds" = ARRAY[la."mediaItemId"];
