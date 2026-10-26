import type { MediaServer } from "./types";

type ServerSyncJob = MediaServer["syncJobs"][number];

/** A job as `GET /api/sync/status` lists it: the whole SyncJob row. */
export interface SyncStatusJob {
  id: string;
  status: string;
  mediaServerId?: unknown;
  startedAt?: unknown;
  completedAt?: string | null;
  itemsProcessed?: unknown;
  totalItems?: unknown;
  currentLibrary?: unknown;
  error?: unknown;
}

const ACTIVE = new Set(["RUNNING", "PENDING"]);

/** The status job's figures in the server list's shape, or null if it lacks them. */
function asServerJob(job: SyncStatusJob): ServerSyncJob | null {
  if (
    typeof job.startedAt !== "string" ||
    typeof job.itemsProcessed !== "number" ||
    typeof job.totalItems !== "number"
  ) {
    return null;
  }
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt ?? null,
    itemsProcessed: job.itemsProcessed,
    totalItems: job.totalItems,
    currentLibrary: typeof job.currentLibrary === "string" ? job.currentLibrary : null,
    error: typeof job.error === "string" ? job.error : null,
  };
}

function sameJob(a: ServerSyncJob, b: ServerSyncJob): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.itemsProcessed === b.itemsProcessed &&
    a.totalItems === b.totalItems &&
    a.currentLibrary === b.currentLibrary &&
    a.error === b.error
  );
}

/**
 * The server list with each running sync's progress taken from the sync
 * status (`GET /api/sync/status`), which a `sync:progress` event asks for in
 * place of the whole server list — that one counts every library's items on
 * each call, and a sync announces progress every two seconds.
 *
 * Only a sync the list already shows as running or queued is updated, and
 * only with a running or queued row: starting a sync's display and ending it
 * stays with a read of the server list (on `sync:started`, `sync:completed`,
 * `sync:failed`), which is what `isSyncRequestSettled` reads. A running row
 * is preferred, as the server list itself prefers it over a newer queued one.
 *
 * Returns the same array when nothing changed, so nothing re-renders for it.
 */
export function mergeSyncProgress(servers: MediaServer[], jobs: readonly SyncStatusJob[]): MediaServer[] {
  let changed = false;
  const next = servers.map((server) => {
    const current = server.syncJobs[0];
    if (!current || !ACTIVE.has(current.status)) return server;
    const active = jobs.filter((job) => job.mediaServerId === server.id && ACTIVE.has(job.status));
    const live = active.find((job) => job.status === "RUNNING") ?? active.find((job) => job.id === current.id);
    const patched = live ? asServerJob(live) : null;
    if (!patched || sameJob(patched, current)) return server;
    changed = true;
    return { ...server, syncJobs: [patched, ...server.syncJobs.slice(1)] };
  });
  return changed ? next : servers;
}
