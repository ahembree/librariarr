export async function register() {
  // Only run background workers on the server side (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Clean up sync jobs orphaned by a previous restart before starting the worker
    const { cleanupOrphanedSyncJobs } = await import("@/lib/sync/cleanup-orphaned-syncs");
    cleanupOrphanedSyncJobs();

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

    // Pre-warm the version + changelog caches, refreshing more often than their
    // 1h TTL so a user request never pays the GitHub round-trip itself.
    const { warmVersionCache } = await import("@/lib/version/update-checker");
    warmVersionCache();
    setInterval(() => { warmVersionCache(); }, 30 * 60 * 1000);
  }
}
