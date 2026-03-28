import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";

interface ServerHistory {
  serverId: string;
  serverName: string;
  serverType: string;
  users: {
    username: string;
    playCount: number;
    lastPlayedAt: string | null;
  }[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    include: {
      library: {
        include: { mediaServer: true },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Find all copies of this item across servers (via dedupKey)
  const copies = item.dedupKey
    ? await prisma.mediaItem.findMany({
        where: {
          dedupKey: item.dedupKey,
          library: { mediaServer: { userId: session.userId, enabled: true } },
        },
        include: {
          library: { include: { mediaServer: true } },
        },
      })
    : [item];

  const serverHistories: ServerHistory[] = [];

  // Query history from each server in parallel
  const results = await Promise.allSettled(
    copies.map(async (copy) => {
      const server = copy.library.mediaServer;
      if (!server) return null;

      try {
        const client = createMediaServerClient(server.type, server.url, server.accessToken, {
          skipTlsVerify: server.tlsSkipVerify,
        });

        const rawHistory = await client.getWatchHistory(
          copy.ratingKey,
          copy.duration ?? undefined
        );

        // Aggregate play counts and latest play date per user
        const userStats = new Map<string, { playCount: number; lastPlayedAt: string | null }>();
        for (const entry of rawHistory) {
          const existing = userStats.get(entry.username);
          if (existing) {
            existing.playCount++;
            if (entry.watchedAt && (!existing.lastPlayedAt || entry.watchedAt > existing.lastPlayedAt)) {
              existing.lastPlayedAt = entry.watchedAt;
            }
          } else {
            userStats.set(entry.username, {
              playCount: 1,
              lastPlayedAt: entry.watchedAt,
            });
          }
        }

        const users = Array.from(userStats.entries())
          .map(([username, stats]) => ({
            username,
            playCount: stats.playCount,
            lastPlayedAt: stats.lastPlayedAt,
          }))
          .sort((a, b) => b.playCount - a.playCount);

        return {
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          users,
        };
      } catch (error) {
        apiLogger.warn("Media", `Failed to fetch watch history from ${server.name}`, { error: String(error) });
        return null;
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      serverHistories.push(result.value);
    }
  }

  // Backwards-compatible flat "history" field (merged across all servers)
  const mergedUserStats = new Map<string, { playCount: number; lastPlayedAt: string | null }>();
  for (const sh of serverHistories) {
    for (const user of sh.users) {
      const existing = mergedUserStats.get(user.username);
      if (existing) {
        existing.playCount += user.playCount;
        if (user.lastPlayedAt && (!existing.lastPlayedAt || user.lastPlayedAt > existing.lastPlayedAt)) {
          existing.lastPlayedAt = user.lastPlayedAt;
        }
      } else {
        mergedUserStats.set(user.username, {
          playCount: user.playCount,
          lastPlayedAt: user.lastPlayedAt,
        });
      }
    }
  }

  const history = Array.from(mergedUserStats.entries())
    .map(([username, stats]) => ({
      username,
      playCount: stats.playCount,
      lastPlayedAt: stats.lastPlayedAt,
    }))
    .sort((a, b) => b.playCount - a.playCount);

  return NextResponse.json({ history, serverHistories });
}
