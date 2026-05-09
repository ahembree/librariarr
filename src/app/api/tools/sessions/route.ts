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

export interface UnreachableServer {
  id: string;
  name: string;
  type: MediaServerType;
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

  const now = Date.now();
  const unreachableServers: UnreachableServer[] = [];

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      const sessions = await client.getSessions();
      return sessions.map<SessionWithServer>((s) => ({
        ...s,
        serverId: server.id,
        serverName: server.name,
        serverType: server.type,
        startedAt: now,
      }));
    }),
  );

  const allSessions: SessionWithServer[] = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      allSessions.push(...result.value);
    } else {
      const server = servers[idx];
      unreachableServers.push({ id: server.id, name: server.name, type: server.type });
    }
  });

  return NextResponse.json({ sessions: allSessions, unreachableServers });
}
