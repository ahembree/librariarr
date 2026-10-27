-- Two indexes no query uses, each paid for on every write to its table.
-- Checked with EXPLAIN ANALYZE on a synthetic 300k-play, 5k-exception
-- database: no plan chose either, and every plan was the same without them.

-- Every lookup by "userId" (the exceptions listing, counts, the per-item
-- checks, the cascade from a User delete) is served by the
-- ("userId", "mediaItemId") unique, which leads with the same column.
DROP INDEX IF EXISTS "LifecycleException_userId_idx";

-- "source" has two values. Every query that filters on it also names the
-- server (served by ("mediaServerId", "source", "watchedAt")) or the item
-- (served by ("mediaItemId")); alone it is never selective enough to pick.
DROP INDEX IF EXISTS "WatchHistory_source_idx";
