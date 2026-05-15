-- AlterTable: add plexLoginEnabled toggle to AppSettings.
-- Default true to preserve existing behavior (Plex login was always available).
ALTER TABLE "AppSettings" ADD COLUMN "plexLoginEnabled" BOOLEAN NOT NULL DEFAULT true;
