/**
 * Graphile Worker task identifiers and queue names.
 *
 * Kept in a dependency-free module so the worker client (enqueue side) and the
 * worker runner (execute side) can share them without creating import cycles.
 */

/** Per-minute dispatcher: evaluates DB-configured schedules and enqueues due work. */
export const TASK_DISPATCH = "dispatch-scheduled";

/** Sync a single media server (optionally scoped to one library). */
export const TASK_SYNC_SERVER = "sync-server";

/**
 * Refresh a single server's watch history only (no full library re-scan).
 * Enqueued by the realtime manager on a `watch-changed` event so watch state
 * lands without waiting for the next full scheduled sync.
 */
export const TASK_SYNC_WATCH_HISTORY = "sync-watch-history";

/**
 * Incrementally sync only the specific items that a real-time `library-changed`
 * event reported as changed/removed — fetch + upsert the changed ones, delete
 * the removed ones — instead of re-scanning the whole server. Falls back to a
 * full {@link TASK_SYNC_SERVER} for oversized or unmappable change sets.
 */
export const TASK_SYNC_INCREMENTAL = "sync-incremental";

/** Run lifecycle rule detection for a user. */
export const TASK_LIFECYCLE_DETECTION = "lifecycle-detection";

/** Execute pending lifecycle actions for a user. */
export const TASK_LIFECYCLE_EXECUTION = "lifecycle-execution";

/** Create a scheduled database backup and prune old backups. */
export const TASK_SCHEDULED_BACKUP = "scheduled-backup";

/** Archive old log entries to disk. */
export const TASK_ARCHIVE_LOGS = "archive-logs";

/** Remove completed/failed lifecycle actions older than the retention window. */
export const TASK_CLEANUP_ACTIONS = "cleanup-old-actions";

/** Delete cached images older than the cache TTL (bounds on-disk growth). */
export const TASK_PRUNE_IMAGE_CACHE = "prune-image-cache";

/**
 * Serial queue for the heavy domain jobs (sync, lifecycle, backup).
 *
 * Jobs sharing a queue name run strictly one-at-a-time, mirroring the original
 * node-cron scheduler which awaited each task sequentially within a single tick.
 * The lightweight dispatcher and housekeeping tasks intentionally omit a queue
 * so a long-running sync never blocks scheduling decisions.
 */
export const MAIN_QUEUE = "librariarr:main";

/** Payload for {@link TASK_SYNC_SERVER}. */
export interface SyncServerPayload {
  serverId: string;
  libraryKey?: string;
  skipWatchHistory?: boolean;
}

/** Payload for {@link TASK_SYNC_WATCH_HISTORY}. */
export interface SyncWatchHistoryPayload {
  serverId: string;
}

/** Payload for {@link TASK_SYNC_INCREMENTAL}. */
export interface SyncIncrementalPayload {
  serverId: string;
  /** ratingKeys to fetch + upsert (present → upsert, missing on server → delete). */
  changedIds: string[];
  /** ratingKeys known to be removed — deleted directly, no fetch. */
  removedIds: string[];
}

/** Payload for lifecycle detection/execution tasks. */
export interface UserPayload {
  userId: string;
}
