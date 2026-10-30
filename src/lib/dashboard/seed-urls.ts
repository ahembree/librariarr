/**
 * The dashboard's opening reads, named once for both sides: the server render
 * answers them (`loadDashboardSeed`) under these URLs, and each zone looks its
 * answer up under the URL it would otherwise fetch. A URL built differently on
 * one side simply misses the seed and is fetched as before, so keep every
 * builder here. Client-safe.
 */

export const SERVERS_URL = "/api/servers?fields=basic";
export const SYNC_STATUS_URL = "/api/sync/status";
export const SCHEDULE_INFO_URL = "/api/settings/schedule-info";
export const LIFECYCLE_SUMMARY_URL = "/api/lifecycle/summary";

/** How many items the Recently Added shelf asks for. */
export const RECENTLY_ADDED_LIMIT = 24;

export type LibraryTypeKey = "MOVIE" | "SERIES" | "MUSIC";

/**
 * The library types the library tiles show, in their order: every type that
 * exists, or all three when none does yet.
 */
export function libraryTileTypes(availableTypes: readonly string[]): LibraryTypeKey[] {
  const all: LibraryTypeKey[] = ["MOVIE", "SERIES", "MUSIC"];
  if (availableTypes.length === 0) return all;
  return all.filter((type) => availableTypes.includes(type));
}

/** The library tiles' one request for every tile's sparkline. */
export function sparklinesUrl(types: readonly string[], serverId?: string): string {
  const params = new URLSearchParams({ types: types.join(",") });
  if (serverId) params.set("serverId", serverId);
  return `/api/media/stats/sparklines?${params}`;
}

/** The Recently Added shelf's request. */
export function recentlyAddedUrl(type?: string, serverId?: string): string {
  const params = new URLSearchParams({ limit: String(RECENTLY_ADDED_LIMIT) });
  if (type) params.set("type", type);
  if (serverId) params.set("serverId", serverId);
  return `/api/media/recently-added?${params}`;
}
