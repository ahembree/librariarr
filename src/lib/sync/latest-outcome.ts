/** The fields of a finished sync job the outcome is decided from. */
export interface FinishedSyncJob {
  status: string;
  completedAt: string | null;
}

/**
 * The sync outcome the idle indicator shows: the most recently FINISHED of
 * the COMPLETED and FAILED jobs, by `completedAt`. Preferring any success hid
 * a failure that came after it behind a green check for as long as that
 * success stayed in the recent-jobs list. A failed job with no `completedAt`
 * is still reported when no success exists.
 */
export function latestSyncOutcome<J extends FinishedSyncJob>(
  jobs: J[],
): { status: "COMPLETED" | "FAILED"; job: J } | null {
  const time = (j: J) => (j.completedAt ? new Date(j.completedAt).getTime() : 0);
  const newest = (status: string) =>
    jobs.filter((j) => j.status === status).sort((a, b) => time(b) - time(a))[0];
  const completed = newest("COMPLETED");
  const failed = newest("FAILED");
  if (failed && (!completed || time(failed) > time(completed))) {
    return { status: "FAILED", job: failed };
  }
  if (completed) return { status: "COMPLETED", job: completed };
  return null;
}
