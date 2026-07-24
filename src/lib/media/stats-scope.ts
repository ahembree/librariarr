import { prisma } from "@/lib/db";

export interface StatsScope {
  /** Enabled media-server IDs in scope (may be empty when none are connected). */
  serverIds: string[];
  /** Restrict breakdowns to the canonical copy across servers (cross-server dedup). */
  dedupEnabled: boolean;
}

/**
 * Resolve which servers a stats / aggregation query runs against, and whether
 * cross-server dedup applies. Centralizes the scoping block shared by the media
 * stats routes and the AI analysis tools: all of the user's enabled servers by
 * default, or a single server when `serverId` is given (dedup off in that
 * case, matching the dashboard's per-server view). Returns the sentinel
 * `"server-not-found"` when `serverId` isn't one of the user's servers so the
 * caller can map it to a 404.
 */
export async function resolveStatsScope(
  userId: string,
  serverId?: string | null,
): Promise<StatsScope | "server-not-found"> {
  const [servers, settings] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId, enabled: true },
      select: { id: true },
    }),
    prisma.appSettings.findUnique({
      where: { userId },
      select: { dedupStats: true },
    }),
  ]);

  let serverIds = servers.map((s) => s.id);
  const dedupEnabled =
    (settings?.dedupStats ?? true) && serverIds.length > 1 && !serverId;

  if (serverId) {
    if (!serverIds.includes(serverId)) return "server-not-found";
    serverIds = [serverId];
  }

  return { serverIds, dedupEnabled };
}
