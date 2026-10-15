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
 * A server that could not be asked is remembered for the same window
 * (`unreachable`), so a dead server does not cost a connection attempt per
 * poll — that was exactly the load the cache exists to remove, in the one
 * case where each attempt is slowest.
 *
 * A termination drops that server's listing (`invalidateSessionListings`,
 * called by `logTermination`, which every successful termination passes
 * through) and keeps the server UNCACHED for the window after it: a media
 * server still reports a just-stopped stream for a moment, and a listing
 * fetched then would otherwise be kept for the full window — longer than the
 * stream would have shown with no cache at all.
 */
export const API_SESSION_LISTING_TTL_MS = 5_000;

const PREFIX = "session-listing:";
const listingKey = (serverId: string) => `${PREFIX}${serverId}`;
const unreachableKey = (serverId: string) => `${PREFIX}unreachable:${serverId}`;

/** Per server, the instant until which a fresh listing is answered but not kept. */
const uncachedUntil = new Map<string, number>();

export async function getCachedSessionListing(
  serverId: string,
  fetchSessions: () => Promise<MediaSession[]>,
): Promise<MediaSession[]> {
  if (appCache.get(unreachableKey(serverId))) {
    throw new Error("Server was unreachable moments ago");
  }
  try {
    return await appCache.getOrSet(listingKey(serverId), fetchSessions, API_SESSION_LISTING_TTL_MS, {
      shouldCache: () => Date.now() >= (uncachedUntil.get(serverId) ?? 0),
    });
  } catch (error) {
    appCache.set(unreachableKey(serverId), true, API_SESSION_LISTING_TTL_MS);
    throw error;
  }
}

/**
 * Drop one server's listing after a termination there, and keep the next
 * listings uncached for the window — or, with no server, every server's
 * listing and the grace (tests).
 */
export function invalidateSessionListings(serverId?: string): void {
  if (serverId === undefined) {
    appCache.invalidatePrefix(PREFIX);
    uncachedUntil.clear();
    return;
  }
  appCache.invalidate(listingKey(serverId));
  appCache.invalidate(unreachableKey(serverId));
  uncachedUntil.set(serverId, Date.now() + API_SESSION_LISTING_TTL_MS);
}
