-- A lifecycle action on ONE episode of a series (a file delete that matched a
-- single episode, or a Query-page action on an individual episode) is named
-- "<Show> SxxExx". Its history row keeps the show's title, but nothing kept the
-- season and episode numbers, so once the episode's MediaItem row is purged
-- after the delete the row could only say which show it was. Actions record
-- them from here on.
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemSeasonNumber" INTEGER;
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemEpisodeNumber" INTEGER;

-- Record them now for every such action whose episode still exists, so a purge
-- from here on does not lose them: a Sonarr file delete with exactly one
-- targeted episode, which need not be the one the action is stored against
-- (see actionTitleSnapshot).
UPDATE "LifecycleAction" AS la
SET "mediaItemSeasonNumber" = mi."seasonNumber",
    "mediaItemEpisodeNumber" = mi."episodeNumber"
FROM "MediaItem" AS mi
WHERE cardinality(la."matchedMediaItemIds") = 1
  AND mi."id" = la."matchedMediaItemIds"[1]
  AND mi."type" = 'SERIES'
  AND la."actionType" IN ('DELETE_FILES_SONARR', 'UNMONITOR_DELETE_FILES_SONARR', 'MONITOR_DELETE_FILES_SONARR');

-- A series action is recorded as its show (title = the show, no parent), the
-- shape scheduling writes. Completed and failed actions were rewritten with the
-- representative episode's own titles instead, and a force-retry compares an
-- episode-level snapshot at the episode level: a metadata refresh re-titling
-- that episode refused the retry of an action on the show as a Fix Match.
UPDATE "LifecycleAction" AS la
SET "mediaItemTitle" = la."mediaItemParentTitle",
    "mediaItemParentTitle" = NULL
WHERE la."mediaItemParentTitle" IS NOT NULL
  AND (
    la."ruleSetType" = 'SERIES'
    OR la."actionType" LIKE '%\_SONARR' ESCAPE '\'
    OR EXISTS (
      SELECT 1 FROM "MediaItem" AS mi
      WHERE mi."id" = la."mediaItemId" AND mi."type" = 'SERIES'
    )
  );
