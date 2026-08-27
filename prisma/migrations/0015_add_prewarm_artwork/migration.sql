-- Warm the grid-size artwork cache after a sync. When true (default), a
-- successful server sync enqueues a background job that fetches and transcodes
-- the artwork the library grids will request, so the first browse of a cold
-- library is a disk read instead of a media-server round trip plus a sharp
-- transcode per visible card. When false, artwork is populated lazily by
-- /api/media/[id]/image on first view, as before.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "prewarmArtwork" BOOLEAN NOT NULL DEFAULT true;
