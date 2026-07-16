-- Master switch for real-time media-server WebSocket sync. When true (default),
-- Librariarr opens a WebSocket per enabled server for instant session/enforcement
-- events and incremental library + watch-history sync. When false, all server
-- WebSockets are closed and the app relies on scheduled polling only.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "realtimeSync" BOOLEAN NOT NULL DEFAULT true;
