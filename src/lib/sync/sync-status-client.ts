import { fetchJsonShared } from "@/lib/shared-fetch";

/** `GET /api/sync/status`'s body: the latest jobs, newest first. */
interface SyncStatusBody {
  jobs?: { id: string; status: string; completedAt: string | null; [key: string]: unknown }[];
}

/**
 * `GET /api/sync/status`, `null` when it fails, shared by every caller in the
 * same synchronous turn — the dashboard's sync indicator and its status strip
 * both read it on mount (see `fetchJsonShared`).
 */
export function fetchSyncStatus(): Promise<SyncStatusBody | null> {
  return fetchJsonShared<SyncStatusBody>("/api/sync/status");
}
