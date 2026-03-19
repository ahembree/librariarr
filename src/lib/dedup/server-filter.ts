/**
 * Shared helpers for API routes to handle server filtering and title preference.
 */

import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";

interface ServerFilterResult {
  serverIds: string[];
  /** Map of serverId → { name, type } for building ServerPresence */
  serverMap: Map<string, { name: string; type: string }>;
  preferredTitleServerId: string | null;
  preferredArtworkServerId: string | null;
  isSingleServer: boolean;
}

/**
 * Resolves server IDs to query, server metadata, and title preference.
 * If `serverId` is provided and valid, narrows to that single server.
 * If `libraryType` is provided, checks how many servers actually have content
 * of that type — avoids expensive multi-server paths when only one server
 * has the relevant library.
 */
export async function resolveServerFilter(
  userId: string,
  serverId: string | null,
  libraryType?: "MOVIE" | "SERIES" | "MUSIC"
): Promise<ServerFilterResult | null> {
  const cacheKey = `server-filter:${userId}:${serverId ?? "all"}:${libraryType ?? "any"}`;
  const cached = appCache.get<ServerFilterResult>(cacheKey);
  if (cached) return cached;

  const [servers, settings, activeServerIds] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId, enabled: true },
      select: { id: true, name: true, type: true },
    }),
    prisma.appSettings.findUnique({
      where: { userId },
      select: { preferredTitleServerId: true, preferredArtworkServerId: true },
    }),
    // When libraryType specified, find which servers actually have libraries of this type
    libraryType
      ? prisma.library
          .findMany({
            where: { type: libraryType, mediaServer: { userId, enabled: true } },
            select: { mediaServerId: true },
            distinct: ["mediaServerId"],
          })
          .then((libs) =>
            libs
              .map((l) => l.mediaServerId)
              .filter((id): id is string => id != null)
          )
      : Promise.resolve(null),
  ]);

  if (servers.length === 0) return null;

  const serverMap = new Map(
    servers.map((s) => [s.id, { name: s.name, type: s.type }])
  );

  let serverIds = servers.map((s) => s.id);
  let isSingleServer = servers.length === 1;

  if (serverId && serverId !== "all") {
    if (!serverMap.has(serverId)) return null; // invalid server
    serverIds = [serverId];
    isSingleServer = true;
  } else if (activeServerIds && activeServerIds.length <= 1) {
    // Multiple servers exist but only 0-1 have content of this library type
    isSingleServer = true;
    if (activeServerIds.length === 1) {
      serverIds = [activeServerIds[0]];
    }
  }

  const result: ServerFilterResult = {
    serverIds,
    serverMap,
    preferredTitleServerId: settings?.preferredTitleServerId ?? null,
    preferredArtworkServerId: settings?.preferredArtworkServerId ?? null,
    isSingleServer,
  };

  appCache.set(cacheKey, result); // 60s default TTL
  return result;
}
