-- Tracks whether a media server's one-time Tracearr history backfill reached
-- the oldest play.
--
-- Tracearr returns history newest-first, so the forward watermark
-- (MAX("watchedAt")) is established by the first page imported and cannot
-- express "how far back have we got". An import interrupted partway therefore
-- resumed from the newest play and silently abandoned all older history.
--
-- Defaults to false: an existing mapped server is treated as not-yet-backfilled
-- so the next sync completes whatever the interrupted one missed. That is the
-- safe direction — the import is an idempotent upsert keyed on
-- ("mediaServerId","sourceEventId"), so re-walking already-imported history
-- costs time, not correctness.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillComplete" BOOLEAN NOT NULL DEFAULT false;

-- The oldest play Tracearr holds for this server, measured once by bisecting the
-- `until` filter. Gives the backfill a determinate progress figure: the walk is
-- complete exactly when it reaches this instant. A record-count figure is not
-- available (no total on the keyset API) and would not be honest anyway, since
-- plays whose media has left the library are deliberately not stored.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrOldestPlayAt" TIMESTAMP(3);

-- How far back the backfill has WALKED, which is not the same as how far back it
-- has stored rows. Resuming from MIN("watchedAt") over stored rows only advances
-- when a record was importable, and plays whose media has left the library are
-- deliberately not stored — so a contiguous unstorable stretch longer than one
-- slice would be re-walked forever. Recording what was seen guarantees progress.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrBackfillCursorAt" TIMESTAMP(3);

-- Marks a server whose stored watch history was deliberately cleared (a
-- watch-history source switch, either direction) and not yet repopulated.
-- `watchedByUser` reads the WatchHistory relation directly, so its negative
-- forms match EVERY item while the relation is empty; the lifecycle
-- evaluability guard refuses to evaluate those rules until this clears.
ALTER TABLE "MediaServer" ADD COLUMN "watchHistoryClearedAt" TIMESTAMP(3);
