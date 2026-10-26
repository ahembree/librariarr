"use client";

import { useRealtime } from "@/hooks/use-realtime";
import { syncCompletedConcerns, type SyncViewScope } from "@/lib/media/sync-scope";

/**
 * Refetch a library view on `sync:completed` — unless the event's meta shows
 * the sync cannot have changed it (another library type, or another server
 * than the one the view shows; see `syncCompletedConcerns`). A reconnect's
 * resync, which carries no meta, always refetches.
 *
 * The shell still drops the tab's list cache on every `sync:completed`; a view
 * that skips here keeps the list it holds, which the sync did not touch, and
 * the next visit to any page loads its list fresh.
 */
export function useLibrarySyncRefetch(scope: SyncViewScope, refetch: () => unknown): void {
  useRealtime("sync:completed", (data) => {
    if (syncCompletedConcerns(data, scope)) void refetch();
  });
}
