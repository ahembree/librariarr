import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaSession } from "@/lib/media-server/types";
import type { MediaServerType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

interface SessionWithServer extends MediaSession {
  serverId: string;
  serverName: string;
  serverType: MediaServerType;
  startedAt: number;
  mediaItemId?: string;
  mediaItemType?: string;
}

const POLL_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 30000;
const MAX_STREAM_LIFETIME = 3600000; // 1 hour safety limit

// Module-level: tracks when each session was first observed
// Key: "serverId:sessionId" → timestamp in ms
const sessionFirstSeen = new Map<string, number>();

async function fetchAllSessions(userId: string): Promise<SessionWithServer[]> {
  const servers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
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
        const key = `${server.id}:${s.sessionId}`;
        if (!sessionFirstSeen.has(key)) {
          sessionFirstSeen.set(key, now);
        }
        allSessions.push({
          ...s,
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          startedAt: sessionFirstSeen.get(key)!,
        });
      }
    } catch {
      // Skip unreachable servers
    }
  }

  // Prune entries for sessions that no longer exist
  const activeKeys = new Set(allSessions.map((s) => `${s.serverId}:${s.sessionId}`));
  for (const key of sessionFirstSeen.keys()) {
    if (!activeKeys.has(key)) {
      sessionFirstSeen.delete(key);
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

  return allSessions;
}

function sessionsFingerprint(sessions: SessionWithServer[]): string {
  return sessions
    .map(
      (s) =>
        `${s.serverId}:${s.sessionId}:${s.player.state}:${s.viewOffset ?? 0}:${s.transcoding?.videoDecision ?? ""}:${s.transcoding?.speed ?? ""}`
    )
    .sort()
    .join("|");
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.userId!;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      let lastFingerprint: string | null = null;

      async function poll() {
        if (closed) return;
        try {
          const sessions = await fetchAllSessions(userId);
          const fingerprint = sessionsFingerprint(sessions);

          // Always send on first poll, then only on change
          if (lastFingerprint === null || fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            send("sessions", { sessions });
          }
        } catch {
          // Will retry on next interval
        }
      }

      // Initial fetch — send immediately
      await poll();

      // Poll Plex servers every 5 seconds
      const pollTimer = setInterval(poll, POLL_INTERVAL);

      // Heartbeat to keep connection alive
      const heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_INTERVAL);

      // Safety net: close after max lifetime in case cancel() is never called
      const maxLifetimeTimer = setTimeout(() => {
        closed = true;
      }, MAX_STREAM_LIFETIME);

      // Cleanup when client disconnects
      const checkClosed = setInterval(() => {
        if (closed) {
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          clearInterval(checkClosed);
          clearTimeout(maxLifetimeTimer);
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      }, 1000);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
