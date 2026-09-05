/**
 * Fetches server presence for a set of dedupKeys.
 *
 * Given items from a paginated query (canonical items only), this function
 * finds all servers that have items with the same dedupKeys and returns
 * a map of dedupKey → ServerPresence[].
 */

import { prisma } from "@/lib/db";
import type { ServerPresence } from "./deduplicate";

/**
 * Build a map of dedupKey → ServerPresence[] for the given keys.
 * Used by flat routes (movies, series, music) to attach multi-server
 * badges to each item.
 */
export async function getServerPresenceByDedupKey(
  dedupKeys: string[],
  serverIds: string[],
): Promise<Map<string, ServerPresence[]>> {
  if (dedupKeys.length === 0) return new Map();

  const items = await prisma.mediaItem.findMany({
    where: {
      dedupKey: { in: dedupKeys },
      library: { mediaServerId: { in: serverIds } },
    },
    select: {
      id: true,
      dedupKey: true,
      library: {
        select: {
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  const map = new Map<string, ServerPresence[]>();

  for (const item of items) {
    if (!item.dedupKey || !item.library.mediaServer) continue;
    const key = item.dedupKey;
    let servers = map.get(key);
    if (!servers) {
      servers = [];
      map.set(key, servers);
    }
    // Avoid duplicate server entries per dedupKey
    if (!servers.some((s) => s.serverId === item.library.mediaServer!.id)) {
      servers.push({
        serverId: item.library.mediaServer.id,
        serverName: item.library.mediaServer.name,
        serverType: item.library.mediaServer.type,
        mediaItemId: item.id,
      });
    }
  }

  // Sort servers alphabetically within each group
  for (const servers of map.values()) {
    servers.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  return map;
}

/**
 * Build a map of groupKey → ServerPresence[] for grouped routes.
 *
 * SERIES groups by `seriesKey` (series identity — the same key the series
 * listing groups on, so two same-titled shows with different TVDB ids get
 * separate presence and the same show across servers merges). MUSIC still
 * groups by normalized `parentTitle` (artist name — there is no artist
 * identity column). The returned map is keyed accordingly: pass the row's
 * `seriesKey` (SERIES) / normalized parentTitle (MUSIC) to look it up.
 */
export async function getServerPresenceByGroup(
  type: "SERIES" | "MUSIC",
  serverIds: string[],
): Promise<Map<string, ServerPresence[]>> {
  const groupKeyExpr =
    type === "SERIES" ? `mi."seriesKey"` : `LOWER(TRIM(mi."parentTitle"))`;
  const notNullCol = type === "SERIES" ? `mi."seriesKey"` : `mi."parentTitle"`;
  const items = await prisma.$queryRawUnsafe<
    {
      group_key: string;
      serverId: string;
      serverName: string;
      serverType: string;
      mediaItemId: string;
    }[]
  >(
    `SELECT DISTINCT ON (${groupKeyExpr}, ms.id)
       ${groupKeyExpr} as group_key,
       ms.id as "serverId", ms.name as "serverName", ms.type::text as "serverType",
       mi.id as "mediaItemId"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     JOIN "MediaServer" ms ON l."mediaServerId" = ms.id
     WHERE mi.type = $1::"LibraryType" AND ${notNullCol} IS NOT NULL
       AND l."mediaServerId" = ANY($2::text[])
     ORDER BY ${groupKeyExpr}, ms.id, mi."createdAt" ASC`,
    type,
    serverIds,
  );

  const map = new Map<string, ServerPresence[]>();

  for (const row of items) {
    let servers = map.get(row.group_key);
    if (!servers) {
      servers = [];
      map.set(row.group_key, servers);
    }
    servers.push({
      serverId: row.serverId,
      serverName: row.serverName,
      serverType: row.serverType,
      mediaItemId: row.mediaItemId,
    });
  }

  for (const servers of map.values()) {
    servers.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  return map;
}
