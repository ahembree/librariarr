import { appCache } from "@/lib/cache/memory-cache";
import type { MediaSession } from "./types";

/**
 * The per-server session listing `GET /api/v1/tools/sessions` answers from.
 *
 * Every call to that route is one `getSessions()` round trip per enabled
 * media server, and an API key may send 600 requests a minute
 * (`apiKeyRequestLimiter`), so an integration polling it — or a leaked key —
 * drove 600 × N requests a minute at the media servers. A listing is kept for
 * `API_SESSION_LISTING_TTL_MS`, the SSE stream's own tick and so the freshest
 * view the app itself offers. Only API-key requests read it: the UI refetches
 * `/api/tools/sessions` on a pushed `session-changed` event and expects to see
 * that change, so a cached answer there would undo the push layer.
 *
 * A failed fetch is never kept (`getOrSet` stores only a resolved value), so an
 * unreachable server is asked again on the next request, and a termination
 * drops every listing (`invalidateSessionListings`) so a client that stops a
 * stream and lists again sees it gone.
 */
export const API_SESSION_LISTING_TTL_MS = 5_000;

const PREFIX = "session-listing:";

export function getCachedSessionListing(
  serverId: string,
  fetchSessions: () => Promise<MediaSession[]>,
): Promise<MediaSession[]> {
  return appCache.getOrSet(`${PREFIX}${serverId}`, fetchSessions, API_SESSION_LISTING_TTL_MS);
}

export function invalidateSessionListings(): void {
  appCache.invalidatePrefix(PREFIX);
}
