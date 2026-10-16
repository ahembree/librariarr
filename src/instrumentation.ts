export async function register() {
  // Only run background workers on the server side (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Clean up sync jobs orphaned by a previous restart before starting the
    // worker — awaited, because the worker's first job can be the interrupted
    // sync itself, and its "already running" guard reads the very RUNNING row
    // this clears: racing it, the retry skipped itself and the sync was dropped.
    // Caught, because a database that is not reachable yet must not turn into
    // an unhandled rejection or block boot; the worker's own start fails the
    // same way and is logged there.
    const { cleanupOrphanedSyncJobs } = await import("@/lib/sync/cleanup-orphaned-syncs");
    await cleanupOrphanedSyncJobs().catch(async (error) => {
      const { logger } = await import("@/lib/logger");
      logger.error("Sync", "Failed to clean up orphaned sync jobs", { error: String(error) });
    });

    // Start the Graphile Worker runner (durable, retrying background jobs).
    // Awaited so the worker's migrations are applied before any request can
    // enqueue a job.
    const { startWorker } = await import("@/lib/jobs/worker");
    await startWorker().catch(() => {
      // startWorker already logs; don't block app boot if the queue is down.
    });

    const { initializeMaintenanceEnforcer, initializePrerollEnforcer } = await import("@/lib/maintenance/enforcer");
    initializeMaintenanceEnforcer();
    initializePrerollEnforcer();

    // Open a WebSocket per enabled media server for real-time session, library,
    // and watch-state events (instant enforcement + incremental sync).
    const { startRealtime } = await import("@/lib/media-server/realtime");
    startRealtime();

    // Backfill dedupKeys for items synced before the dedup columns were added
    const { runBackfillIfNeeded } = await import("@/lib/dedup/recompute-canonical");
    runBackfillIfNeeded();

    // Start the GitHub release lookups now so no request waits on them.
    // Requests refresh them in the background after that; this keeps them
    // current while nobody is looking.
    const { warmVersionCache } = await import("@/lib/version/update-checker");
    warmVersionCache();
    setInterval(() => { warmVersionCache(); }, 6 * 60 * 60 * 1000);
  }
}
