-- Indexes for lookups that read whole tables. Each was measured with EXPLAIN
-- ANALYZE on a synthetic 170k-item library (11k matches, 2k exceptions, 300k
-- log rows, 150k plays).

-- A MediaItem delete cascades to RuleMatch and LifecycleException, and neither
-- had an index leading with mediaItemId (their uniques lead with ruleSetId and
-- userId), so every deleted item scanned both tables: a 3,000-item purge spent
-- 1.8 s and 0.3 s in those two cascades, 30 ms with the indexes. A
-- `mediaItemId IN (…)` read that names no rule set went 60 ms -> 1 ms.
CREATE INDEX "RuleMatch_mediaItemId_idx" ON "RuleMatch"("mediaItemId");
CREATE INDEX "LifecycleException_mediaItemId_idx" ON "LifecycleException"("mediaItemId");

-- System Logs filters on level, category and source and orders newest first.
-- A single-column index finds a filter's rows and sorts them; the composite
-- returns its newest rows in order. Where a filter's rows are old (a source
-- that last logged days ago) the planner walked the createdAt index instead
-- and read the whole table: 47 ms -> 0.14 ms. The composites serve every
-- lookup the level and source indexes did, so those go. The category index
-- stays: three values deduplicate to a 2 MB index, the smallest on the table,
-- and the page's unfiltered row count is an index-only scan of it (~15 ms on
-- 300k rows, against ~25 ms seq-scanning without it).
DROP INDEX IF EXISTS "LogEntry_level_idx";
DROP INDEX IF EXISTS "LogEntry_source_idx";
CREATE INDEX "LogEntry_level_createdAt_idx" ON "LogEntry"("level", "createdAt");
CREATE INDEX "LogEntry_category_createdAt_idx" ON "LogEntry"("category", "createdAt");
CREATE INDEX "LogEntry_source_createdAt_idx" ON "LogEntry"("source", "createdAt");

-- The Tracearr import's watermarks and its status readout aggregate one
-- server's TRACEARR plays. With this index each watermark is a probe at one
-- end of it (27 ms -> 0.8 ms for the three) and the status an index-only scan.
-- [mediaServerId] alone is covered by this, the (mediaServerId, sourceEventId)
-- unique and the (mediaServerId, watchedAt) index.
DROP INDEX IF EXISTS "WatchHistory_mediaServerId_idx";
CREATE INDEX "WatchHistory_mediaServerId_source_watchedAt_idx" ON "WatchHistory"("mediaServerId", "source", "watchedAt");

-- Two indexes no plan chose on the same database, each paid for on every write
-- to its table. Every lookup by LifecycleException "userId" (the exceptions
-- listing, counts, the per-item checks, the cascade from a User delete) is
-- served by the ("userId", "mediaItemId") unique, which leads with the same
-- column. WatchHistory "source" has two values: every query that filters on it
-- also names the server (served by the index above) or the item (served by
-- ("mediaItemId")), and alone it is never selective enough to pick.
DROP INDEX IF EXISTS "LifecycleException_userId_idx";
DROP INDEX IF EXISTS "WatchHistory_source_idx";

-- Artist lookups match the artist the way the music listings group it,
-- `LOWER(TRIM("parentTitle"))` (album list, artist summary, series watch
-- history): a scan of every item of the type before, 20 ms -> 0.1 ms.
--
-- Not in schema.prisma: Prisma cannot declare an expression index. `prisma db
-- push`, which the entrypoint runs after `migrate deploy`, leaves an index it
-- cannot represent alone, so it survives.
CREATE INDEX "MediaItem_type_parentTitle_norm_idx" ON "MediaItem"("type", LOWER(TRIM("parentTitle")));

-- Trigram indexes for the `%q%` ILIKE searches (library search, the search
-- palette, the album list): 25-124 ms -> 0.2-2.6 ms. They make inserting and
-- re-titling items dearer (about 0.14 ms more per row), which a sync pays only
-- for the items it writes.
--
-- pg_trgm is a trusted extension (any role with CREATE on the database may add
-- it), but a database the app does not own, or a build without contrib, can
-- refuse it. Search works without these indexes, so a refusal skips them with
-- a notice rather than failing the migration and keeping the app from
-- starting. The operator class is qualified with the extension's own schema,
-- which need not be on the search path.
--
-- Not in schema.prisma, and deliberately partial: `db push` drops a plain index
-- the schema does not list, and declaring these there would need the
-- `postgresqlExtensions` preview feature (and pg_trgm in every database
-- `db push` runs on). It leaves a partial index alone, as it does the
-- expression index above. `"title" IS NOT NULL` excludes nothing (title is
-- required) and every ILIKE on the column implies it, so the planner uses
-- these exactly as it would full indexes. Turning on the `partialIndexes`
-- preview feature would make `db push` manage partial indexes too and drop
-- these unless they are declared.
DO $$
DECLARE
  trgm_schema text;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm is not available (%); skipping the trigram search indexes', SQLERRM;
  END;

  SELECT n.nspname INTO trgm_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF trgm_schema IS NOT NULL THEN
    BEGIN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS "MediaItem_title_trgm_idx" ON "MediaItem" USING GIN ("title" %I.gin_trgm_ops) WHERE "title" IS NOT NULL',
        trgm_schema);
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS "MediaItem_parentTitle_trgm_idx" ON "MediaItem" USING GIN ("parentTitle" %I.gin_trgm_ops) WHERE "parentTitle" IS NOT NULL',
        trgm_schema);
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS "MediaItem_albumTitle_trgm_idx" ON "MediaItem" USING GIN ("albumTitle" %I.gin_trgm_ops) WHERE "albumTitle" IS NOT NULL',
        trgm_schema);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not create the trigram search indexes (%); search still works without them', SQLERRM;
    END;
  END IF;
END
$$;
