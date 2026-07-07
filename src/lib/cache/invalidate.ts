/**
 * Centralized invalidation for all caches derived from media data.
 *
 * Any mutation that changes the set of media items, their server membership,
 * dedup canonical selection, or the title/artwork preference must call this so
 * that read-heavy cached paths (library listings, alphabet bars, dashboard
 * stats/insight charts, filter dropdowns) don't serve stale data.
 *
 * Keeping the full prefix list in one place prevents the recurring class of bug
 * where a new write path invalidates some caches but forgets others.
 */

import { appCache } from "./memory-cache";

/** Cache-key prefixes that depend on the current media dataset. */
const MEDIA_CACHE_PREFIXES = [
  "server-filter:",
  "distinct-values",
  "stats:",
  "letters:",
  "group-summary:",
  "cross-tab:",
  "custom-stats:",
  "timeline:",
  "watch-history-filters:",
  // Per-item image metadata (server URL/token/thumb paths). A re-sync or server
  // URL/token change can alter these, so drop them here too rather than waiting
  // out the 5-min TTL.
  "image-meta:",
  // Per-run memoized safety re-query for batched ad-hoc query actions. Derived
  // from the live media set, so a mutation (sync/purge) must drop it — a
  // mid-run batch then recomputes against fresh data rather than a stale set.
  "query-action-live:",
] as const;

export function invalidateMediaCaches(): void {
  for (const prefix of MEDIA_CACHE_PREFIXES) {
    appCache.invalidatePrefix(prefix);
  }
}
