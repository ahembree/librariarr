-- The incremental native watch-history refresh (realtime `watch-changed`)
-- resolves its window from MAX("watchedAt") for one server and dedups the
-- overlap against the rows at or after it. Both are a single index probe with
-- this composite; without it each is a scan of the server's whole history,
-- once per finished playback.
CREATE INDEX "WatchHistory_mediaServerId_watchedAt_idx" ON "WatchHistory"("mediaServerId", "watchedAt");
