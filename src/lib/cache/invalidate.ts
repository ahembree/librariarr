/**
 * Centralized invalidation for all caches derived from media data.
 *
 * Any mutation that changes the set of media items, their server membership,
 * dedup canonical selection, or the title/artwork preference must call this so
 * that read-heavy cached paths (library listings, dashboard
 * stats/insight charts, filter dropdowns) don't serve stale data.
 *
 * Keeping the full prefix list in one place prevents the recurring class of bug
 * where a new write path invalidates some caches but forgets others.
 */

import { appCache } from "./memory-cache";
import { LIST_RESPONSE_CACHE_PREFIX } from "./list-response-prefix";

/** Cache-key prefixes that depend on the current media dataset. */
const MEDIA_CACHE_PREFIXES = [
  "server-filter:",
  // The library filter dropdowns (and the genre spellings the genre filter
  // matches with, `distinct-values:genres`).
  "distinct-values",
  // The Query page's own dropdowns: a different key, which no prefix above
  // covers — they stayed stale for their whole TTL after every sync.
  "query-distinct-values",
  "stats:",
  "group-summary:",
  "cross-tab:",
  "custom-stats:",
  "timeline:",
  "watch-history-filters:",
  "recently-added:",
  // Per-item image metadata (server URL/token/thumb paths). A re-sync or server
  // URL/token change can alter these, so drop them here too rather than waiting
  // out the 5-min TTL.
  "image-meta:",
  // Per-run memoized safety re-query for batched ad-hoc query actions. Derived
  // from the live media set, so a mutation (sync/purge) must drop it — a
  // mid-run batch then recomputes against fresh data rather than a stale set.
  "query-action-live:",
  // The library listings' finished responses (`withListResponseCache`).
  LIST_RESPONSE_CACHE_PREFIX,
] as const;

export function invalidateMediaCaches(): void {
  for (const prefix of MEDIA_CACHE_PREFIXES) {
    appCache.invalidatePrefix(prefix);
  }
}

/**
 * Rule set names appear in both distinct-values payloads ("Matched By Rule
 * Set"), which no media mutation touches. A rule set created, renamed or
 * deleted must drop them, or the rule editor offers the old list for the rest
 * of the 5-minute TTL. Only those two keys: the genre spellings cached beside
 * them do not depend on rule sets.
 */
export function invalidateRuleSetNameCaches(): void {
  appCache.invalidate("distinct-values");
  appCache.invalidate("query-distinct-values");
}

/**
 * The image proxy's negative cache (`/api/media/[id]/image`): an artwork fetch
 * that failed is not retried for a minute, per server connection and artwork
 * path. Kept here so the route that caches a failure and the server edit that
 * drops them (`invalidateImageFailures`) cannot name different keys.
 *
 * The URL is encoded so `:` cannot occur in it: the prefix of one server's
 * entries is then never a prefix of another's (`http://plex` of
 * `http://plex:32400`).
 */
const IMAGE_FAILURE_PREFIX = "image-fail:";

export function imageFailureCacheKey(serverUrl: string, thumbPath: string): string {
  return `${IMAGE_FAILURE_PREFIX}${encodeURIComponent(serverUrl)}:${thumbPath}`;
}

/**
 * Drop every cached artwork failure of the server at `serverUrl` — the URL the
 * failures were recorded under, i.e. the one stored before an edit. A failure
 * is about one connection: after a new token or certificate setting at the
 * same URL, a thumb that failed a moment ago may load now, and kept, it would
 * answer 502 for up to a minute. Not part of `invalidateMediaCaches`: a sync
 * does not change whether a server's artwork can be fetched.
 */
export function invalidateImageFailures(serverUrl: string): void {
  appCache.invalidatePrefix(`${IMAGE_FAILURE_PREFIX}${encodeURIComponent(serverUrl)}:`);
}

/**
 * `/api/integrations/health`'s cached answer. One key, not one per user: the
 * app has a single admin. Kept here so the route that caches it and the
 * routes that drop it (every instance add/edit/delete of a type it checks,
 * in `instanceChanged`; `invalidateSeerrCaches`) cannot name different keys.
 */
export const INTEGRATIONS_HEALTH_CACHE_KEY = "integrations:health";
