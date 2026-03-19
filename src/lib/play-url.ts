export interface PlayServer {
  serverName: string;
  serverType: string;
  serverUrl: string;
  machineId: string | null;
  ratingKey: string;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  label?: string;
}

/**
 * Builds a deep link URL to open/play an item in its media server's web UI.
 */
export function buildPlayUrl(server: PlayServer): string {
  const baseUrl = server.serverUrl.replace(/\/+$/, "");

  switch (server.serverType) {
    case "PLEX":
      if (server.machineId) {
        // Plex web app — works remotely
        return `https://app.plex.tv/desktop/#!/server/${server.machineId}/details?key=${encodeURIComponent(`/library/metadata/${server.ratingKey}`)}`;
      }
      // Fallback to local server URL
      return `${baseUrl}/web/index.html#!/server/details?key=${encodeURIComponent(`/library/metadata/${server.ratingKey}`)}`;

    case "JELLYFIN":
      return `${baseUrl}/web/index.html#/details?id=${server.ratingKey}`;

    case "EMBY":
      return `${baseUrl}/web/index.html#!/item?id=${server.ratingKey}`;

    default:
      return baseUrl;
  }
}

/**
 * Expand raw play servers into labeled links for each available media hierarchy level.
 *
 * @param levels - Array of [label, keyField] pairs in display order, e.g.:
 *   [["Episode", "ratingKey"], ["Season", "parentRatingKey"], ["Series", "grandparentRatingKey"]]
 */
export function buildPlayLinks(
  servers: PlayServer[],
  levels: [string, "ratingKey" | "parentRatingKey" | "grandparentRatingKey"][],
): PlayServer[] {
  const links: PlayServer[] = [];
  for (const ps of servers) {
    for (const [label, keyField] of levels) {
      const key = ps[keyField];
      if (key) {
        links.push({ ...ps, ratingKey: key, label });
      }
    }
  }
  return links;
}
