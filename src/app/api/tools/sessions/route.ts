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

  return NextResponse.json({ sessions: allSessions });
}
