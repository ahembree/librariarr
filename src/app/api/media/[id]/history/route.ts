import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";

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

  try {
    const server = item.library.mediaServer;
    const client = createMediaServerClient(server.type, server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });

    const rawHistory = await client.getWatchHistory(
      item.ratingKey,
      item.duration ?? undefined
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

    const history = Array.from(userStats.entries())
      .map(([username, stats]) => ({
        username,
        playCount: stats.playCount,
        lastPlayedAt: stats.lastPlayedAt,
      }))
      .sort((a, b) => b.playCount - a.playCount);

    return NextResponse.json({ history });
  } catch (error) {
    apiLogger.error("Media", "Failed to fetch watch history", { error: String(error) });
    return NextResponse.json({ history: [] });
  }
}
