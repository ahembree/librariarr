-- How far back the next forward Tracearr pass must reach. A forward walk goes
-- newest -> oldest, so one that commits a page and then stops moves the forward
-- watermark (MAX("watchedAt")) past plays it never read; the next run's window,
-- derived from that watermark, started above them and they were never
-- imported. Recorded when such a walk stops and cleared once a forward walk
-- covers its whole window. Null for every existing server: nothing records
-- whether an earlier forward walk was interrupted.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardFloorAt" TIMESTAMP(3);
