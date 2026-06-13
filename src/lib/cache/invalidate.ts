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
] as const;

export function invalidateMediaCaches(): void {
  for (const prefix of MEDIA_CACHE_PREFIXES) {
    appCache.invalidatePrefix(prefix);
  }
}
