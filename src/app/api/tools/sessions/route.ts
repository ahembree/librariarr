import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaSession } from "@/lib/media-server/types";
import type { MediaServerType } from "@/generated/prisma/client";

export interface SessionWithServer extends MediaSession {
  serverId: string;
  serverName: string;
  serverType: MediaServerType;
  startedAt: number;
  mediaItemId?: string;
  mediaItemType?: string;
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId!, enabled: true },
    select: { id: true, name: true, url: true, accessToken: true, tlsSkipVerify: true, type: true },
  });

  const allSessions: SessionWithServer[] = [];
  const now = Date.now();

  for (const server of servers) {
    try {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      const sessions = await client.getSessions();
      for (const s of sessions) {
        allSessions.push({ ...s, serverId: server.id, serverName: server.name, serverType: server.type, startedAt: now });
      }
    } catch {
      // Skip unreachable servers
    }
  }

  // Resolve ratingKeys to mediaItemIds via batch DB lookup
  const ratingKeyPairs = allSessions
    .filter((s) => s.ratingKey)
    .map((s) => ({ serverId: s.serverId, ratingKey: s.ratingKey! }));

  if (ratingKeyPairs.length > 0) {
    const serverIds = [...new Set(ratingKeyPairs.map((p) => p.serverId))];
    const ratingKeys = [...new Set(ratingKeyPairs.map((p) => p.ratingKey))];

    const items = await prisma.mediaItem.findMany({
      where: {
        ratingKey: { in: ratingKeys },
        library: { mediaServerId: { in: serverIds } },
      },
      select: { id: true, type: true, ratingKey: true, library: { select: { mediaServerId: true } } },
    });

    const lookup = new Map(
      items.map((i) => [`${i.library.mediaServerId}:${i.ratingKey}`, { id: i.id, type: i.type }]),
    );

    for (const s of allSessions) {
      if (s.ratingKey) {
        const match = lookup.get(`${s.serverId}:${s.ratingKey}`);
        if (match) {
          s.mediaItemId = match.id;
          s.mediaItemType = match.type;
        }
      }
    }
  }

  return NextResponse.json({ sessions: allSessions });
}
