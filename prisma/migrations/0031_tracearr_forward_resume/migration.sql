-- The start of a forward (catch-up) window the Tracearr import has not
-- finished walking. Tracearr serves history newest first, so a catch-up that
-- stops after a page has already stored the newest plays, and the next window
-- -- derived from MAX("watchedAt") -- would start above the stretch it never
-- reached. NULL on every existing row: no unfinished window is recorded yet.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardResumeAt" TIMESTAMP(3);
