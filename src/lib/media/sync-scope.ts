/**
 * Whether a `sync:completed` event can have changed what a library view shows.
 * Client-safe.
 *
 * Every library page refetched its whole list on every completed sync — a
 * Movies page re-pulled tens of thousands of rows because a music library on
 * another server synced. The event's meta now names the server and, when the
 * run knows, the library types it wrote (`SyncCompletedMeta`); a view whose
 * type is not among them, or that shows one server other than the one synced,
 * keeps its list.
 *
 * Absent meta always means "refetch": an older server, a run that could not
 * say what it touched, and a reconnect's resync (which calls every subscriber
 * with `{}`, standing for every event missed) all read as "may have changed".
 */

import type { SyncLibraryType } from "@/lib/sync/sync-completed-meta";

export interface SyncViewScope {
  /** The view's library type, or several (a view spanning types, e.g. the dashboard shelf). */
  types: SyncLibraryType | readonly SyncLibraryType[] | null;
  /**
   * The one server the view shows, or "all"/null/undefined for every server.
   * A single-server listing reads that server's rows alone (no dedup, no
   * other-server presence chips), so another server's sync cannot change it.
   */
  serverId?: string | null;
}

export function syncCompletedConcerns(event: unknown, scope: SyncViewScope): boolean {
  if (!event || typeof event !== "object") return true;
  const meta = event as { serverId?: unknown; libraryTypes?: unknown };

  if (scope.serverId && scope.serverId !== "all" && typeof meta.serverId === "string" && meta.serverId !== scope.serverId) {
    return false;
  }

  if (scope.types && Array.isArray(meta.libraryTypes)) {
    const wanted = typeof scope.types === "string" ? [scope.types] : scope.types;
    if (wanted.length > 0 && !wanted.some((type) => (meta.libraryTypes as unknown[]).includes(type))) return false;
  }

  return true;
}
