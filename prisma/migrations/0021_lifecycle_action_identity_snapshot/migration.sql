-- Before a pending action runs, the scheduled executor re-checks that its item
-- is still the work it was scheduled for: a Plex "Fix Match" or a Jellyfin
-- "Identify" rewrites the same row, same id, to different content. The check
-- compared titles only. These columns add the year and the external id the Arr
-- app resolves the item by (TMDB, TVDB, MusicBrainz), so a re-identification
-- that keeps the title ("Dune" 1984 → 2021) is refused too. New actions record
-- both when they are scheduled.
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemYear" INTEGER;
ALTER TABLE "LifecycleAction" ADD COLUMN "mediaItemExternalId" TEXT;

-- Actions already pending were scheduled without them: record them from the
-- item as it is now, so a re-identification from here on is caught for these
-- actions as well.
UPDATE "LifecycleAction" AS la
SET "mediaItemYear" = mi."year",
    "mediaItemExternalId" = (
      SELECT e."externalId"
      FROM "MediaItemExternalId" AS e
      WHERE e."mediaItemId" = mi."id"
        AND e."source" = CASE rs."type"
          WHEN 'MOVIE' THEN 'TMDB'
          WHEN 'MUSIC' THEN 'MUSICBRAINZ'
          ELSE 'TVDB'
        END
    )
FROM "MediaItem" AS mi, "RuleSet" AS rs
WHERE la."status" = 'PENDING'
  AND mi."id" = la."mediaItemId"
  AND rs."id" = la."ruleSetId";

-- Until now the check compared the title of a series match, or of an
-- artist-scope music match, with the title of the episode or track it is
-- stored against. Such a match is recorded as its group: the show or artist
-- as the title, no parent title. So the check cancelled every one of those
-- actions when it came due; detection scheduled it again and it was cancelled
-- again. They run from this release on, deleting ones included. None of them
-- has ever run, so the ones already pending are held until at least a week
-- after the upgrade: time to review them on the Pending page before they act
-- for the first time. Selected by that group snapshot rather than by the rule
-- set's current scope, which can have changed since they were scheduled.
-- (`scheduledFor` holds UTC, like every Prisma DateTime.)
UPDATE "LifecycleAction" AS la
SET "scheduledFor" = GREATEST(la."scheduledFor", (NOW() AT TIME ZONE 'UTC') + INTERVAL '7 days')
FROM "RuleSet" AS rs
WHERE la."status" = 'PENDING'
  AND rs."id" = la."ruleSetId"
  AND rs."type" IN ('SERIES', 'MUSIC')
  AND la."mediaItemTitle" IS NOT NULL
  AND la."mediaItemParentTitle" IS NULL;
