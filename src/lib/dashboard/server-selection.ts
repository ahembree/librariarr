/** A server as the dashboard's selectors list it. */
export interface DashboardServer {
  id: string;
  name: string;
  type: string;
}

/** The value of the dashboard's server selector meaning "every server". */
export const ALL_SERVERS = "all";

/**
 * Servers the dashboard may offer for filtering. Stats, timelines and Recently
 * Added cover enabled servers only and answer 404 for a disabled one, so
 * offering it left the previous selection's figures on screen under its name.
 */
export function selectableServers(
  raw: { id: string; name: string; type: string; enabled?: boolean }[],
): DashboardServer[] {
  return raw
    .filter((s) => s.enabled !== false)
    .map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

/**
 * Keep the selection when it is still selectable, else fall back to every
 * server: a deleted or disabled selection made every later stats fetch 404
 * and froze the figures.
 */
export function reconcileSelectedServer(selected: string, servers: DashboardServer[]): string {
  if (selected === ALL_SERVERS) return selected;
  return servers.some((s) => s.id === selected) ? selected : ALL_SERVERS;
}

/** The stats URL for the current selection. */
export function dashboardStatsUrl(selected: string): string {
  return selected === ALL_SERVERS
    ? "/api/media/stats"
    : `/api/media/stats?${new URLSearchParams({ serverId: selected })}`;
}
