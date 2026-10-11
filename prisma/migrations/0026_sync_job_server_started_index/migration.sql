-- `GET /api/servers` (the Settings, dashboard, library and lifecycle pages all
-- call it) reads each server's newest sync job. SyncJob rows are never pruned,
-- so without this every call sorted the server's whole sync history.
CREATE INDEX "SyncJob_mediaServerId_startedAt_idx" ON "SyncJob"("mediaServerId", "startedAt");
