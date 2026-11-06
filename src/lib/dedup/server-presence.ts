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
 *
 * One statement with the keys as a single array parameter. The keys are every
 * listed row's, so the remainder of a progressive load (`limit=0&offset=100`)
 * passes one per canonical row of the library. As a Prisma `in` list that was
 * a bind parameter per key, and Prisma (7.10) splits an over-long list into
 * several statements only for an unordered, unpaged `findMany` — this one was
 * ordered (oldest copy first) — so past 32,767 the Movies, Episodes and Tracks
 * remainder requests answered 500 (P2029) and the pages silently stopped at
 * their first 100 rows.
 */
export async function getServerPresenceByDedupKey(
  dedupKeys: string[],
  serverIds: string[],
): Promise<Map<string, ServerPresence[]>> {
  if (dedupKeys.length === 0 || serverIds.length === 0) return new Map();

  // A server holding two copies lists the oldest (by `createdAt`, then id), as
  // getServerPresenceByGroup does — see `readGroupPresence` for the aggregate.
  const rows = await prisma.$queryRawUnsafe<PresenceRow[]>(
    `SELECT p.group_key,
       ms.id as "serverId", ms.name as "serverName", ms.type::text as "serverType",
       p.media_item_id as "mediaItemId"
     FROM (
       SELECT mi."dedupKey" as group_key, l."mediaServerId" as server_id,
         (MIN(ARRAY[to_char(mi."createdAt", 'YYYYMMDDHH24MISSUS'), mi.id]))[2] as media_item_id
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l.id
       WHERE mi."dedupKey" = ANY($1::text[])
         AND l."mediaServerId" = ANY($2::text[])
       GROUP BY 1, 2
     ) p
     JOIN "MediaServer" ms ON ms.id = p.server_id`,
    [...new Set(dedupKeys)],
    serverIds,
  );
  return foldPresence(rows);
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
  options?: GroupPresenceScope,
): Promise<Map<string, ServerPresence[]>> {
  if (serverIds.length === 0 || options?.groupKeys?.length === 0) return new Map();
  return foldPresence(await readGroupPresence(type, serverIds, options?.groupKeys ?? null));
}

/** Which groups `getServerPresenceByGroup` answers for. */
export interface GroupPresenceScope {
  /**
   * Only these groups, keyed as the map is (a `seriesKey` for SERIES, the
   * normalized artist title for MUSIC). A listing that returns a page, or that
   * a filter narrows to a few shows, needs presence for those alone: across a
   * whole library the scan was the slowest part of the multi-server Series
   * listing (~150–270 ms on 100k episodes against ~2–6 ms for 50 shows).
   * Omitted: every group.
   */
  groupKeys?: readonly string[];
}

/**
 * The presence of ONE show or artist, for the group-summary route. MUSIC
 * matches the artist title as the listings group it (`LOWER(TRIM(…))` in SQL),
 * so a caller holding one of its stored spellings needs no normalization of
 * its own.
 */
export async function getServerPresenceForGroup(
  type: "SERIES" | "MUSIC",
  serverIds: string[],
  group: { seriesKey: string } | { parentTitle: string },
): Promise<ServerPresence[]> {
  if (serverIds.length === 0) return [];
  const rows =
    "seriesKey" in group
      ? await readGroupPresence(type, serverIds, [group.seriesKey])
      : await readGroupPresence(type, serverIds, null, group.parentTitle);
  return [...foldPresence(rows).values()][0] ?? [];
}

interface PresenceRow {
  group_key: string;
  serverId: string;
  serverName: string;
  serverType: string;
  mediaItemId: string;
}

/**
 * One row per group and server: the server's OLDEST item of the group (ties
 * by id), as a server holding two copies has always been listed.
 *
 * A GROUP BY taking `MIN(ARRAY[createdAt as fixed-width text, id])[2]`
 * rather than a `DISTINCT ON` ordered by `createdAt, id`: the DISTINCT ON
 * sorted every episode of the library (an external merge sort under the
 * default `work_mem`), where the aggregate hashes one entry per group and
 * server. Same rows; measured on 100k episodes over 2 servers, 266 ms → 153
 * ms for the whole library, 112 → 80 ms for 40k tracks. The timestamp is
 * written as digits of fixed width (`YYYYMMDDHH24MISSUS`, no locale part), so
 * the text comparison orders it as the timestamp comparison did.
 */
function readGroupPresence(
  type: "SERIES" | "MUSIC",
  serverIds: string[],
  groupKeys: readonly string[] | null,
  title?: string,
): Promise<PresenceRow[]> {
  const groupKeyExpr =
    type === "SERIES" ? `mi."seriesKey"` : `LOWER(TRIM(mi."parentTitle"))`;
  const notNullCol = type === "SERIES" ? `mi."seriesKey"` : `mi."parentTitle"`;
  const params: unknown[] = [type, serverIds];
  let scope = "";
  if (groupKeys) {
    params.push(groupKeys);
    scope = `AND ${groupKeyExpr} = ANY($${params.length}::text[])`;
  } else if (title !== undefined) {
    params.push(title);
    scope = `AND ${groupKeyExpr} = LOWER(TRIM($${params.length}))`;
  }
  return prisma.$queryRawUnsafe<PresenceRow[]>(
    `SELECT p.group_key,
       ms.id as "serverId", ms.name as "serverName", ms.type::text as "serverType",
       p.media_item_id as "mediaItemId"
     FROM (
       SELECT ${groupKeyExpr} as group_key, l."mediaServerId" as server_id,
         (MIN(ARRAY[to_char(mi."createdAt", 'YYYYMMDDHH24MISSUS'), mi.id]))[2] as media_item_id
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l.id
       WHERE mi.type = $1::"LibraryType" AND ${notNullCol} IS NOT NULL
         AND l."mediaServerId" = ANY($2::text[])
         ${scope}
       GROUP BY 1, 2
     ) p
     JOIN "MediaServer" ms ON ms.id = p.server_id`,
    ...params,
  );
}

function foldPresence(items: PresenceRow[]): Map<string, ServerPresence[]> {
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
    servers.sort((a, b) => a.serverName.localeCompare(b.serverName) || a.serverId.localeCompare(b.serverId));
  }

  return map;
}
