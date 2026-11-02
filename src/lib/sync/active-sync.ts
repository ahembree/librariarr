/** The fields of an active sync job the per-server view is decided from. */
interface ActiveSyncJob {
  mediaServerId: string;
  status: string;
  startedAt: string;
}

/**
 * One active sync per server, for the views that draw a line per sync. A
 * server can hold several active rows at once — a library page's Sync queues
 * one row per library job, and it can queue them behind a sync already
 * running — and a line per row showed "Syncing Plex" two or three times over.
 * The RUNNING row wins (its progress is the one moving); a server with only
 * queued rows shows its oldest, the one that will run first. Servers keep the
 * order they first appear in.
 */
export function activeSyncPerServer<J extends ActiveSyncJob>(jobs: J[]): J[] {
  const byServer = new Map<string, J>();
  for (const job of jobs) {
    if (job.status !== "RUNNING" && job.status !== "PENDING") continue;
    const current = byServer.get(job.mediaServerId);
    if (!current) {
      byServer.set(job.mediaServerId, job);
    } else if (current.status !== "RUNNING") {
      if (job.status === "RUNNING" || Date.parse(job.startedAt) < Date.parse(current.startedAt)) {
        byServer.set(job.mediaServerId, job);
      }
    }
  }
  return [...byServer.values()];
}
