export async function register() {
  // Only run scheduler on the server side (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeScheduler } = await import("@/lib/scheduler/scheduler");
    initializeScheduler();

    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");
    initializeMaintenanceEnforcer();

    // Backfill dedupKeys for items synced before the dedup columns were added
    const { runBackfillIfNeeded } = await import("@/lib/dedup/recompute-canonical");
    runBackfillIfNeeded();

    // Pre-warm version check cache and refresh every 6 hours
    const { warmVersionCache } = await import("@/lib/version/update-checker");
    warmVersionCache();
    setInterval(() => { warmVersionCache(); }, 6 * 60 * 60 * 1000);
  }
}
