-- Revisions for the two display settings a save replaces whole: a tab or
-- device saving a layout or a column list it loaded before another one saved
-- would otherwise overwrite that newer save. Each save sends the revision it
-- was based on and is refused when the stored one has moved on.
ALTER TABLE "AppSettings" ADD COLUMN "dashboardLayoutRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AppSettings" ADD COLUMN "columnPreferencesRevision" INTEGER NOT NULL DEFAULT 0;
