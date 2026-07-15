import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { realtimeBus } from "@/lib/media-server/realtime";
import type { MediaSession } from "@/lib/media-server/types";
import type { MediaServerType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// Minimum spacing between realtime-triggered polls. A playing stream emits
// session events ~every second, so without this the socket would drive one
// getSessions() per second per active stream — worse than plain polling.
const EVENT_POLL_MIN_MS = 2000;

interface SessionWithServer extends MediaSession {
  serverId: string;
  serverName: string;
  serverType: MediaServerType;
  startedAt: number;
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

  const now = Date.now();

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      const sessions = await client.getSessions();
      return sessions.map<SessionWithServer>((s) => {
        const key = `${server.id}:${s.sessionId}`;
        if (!sessionFirstSeen.has(key)) {
          sessionFirstSeen.set(key, now);
        }
        return {
          ...s,
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          startedAt: sessionFirstSeen.get(key)!,
        };
      });
    }),
  );

  const allSessions: SessionWithServer[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") allSessions.push(...result.value);
  }

  // Prune entries for sessions that no longer exist
  const activeKeys = new Set(allSessions.map((s) => `${s.serverId}:${s.sessionId}`));
  for (const key of sessionFirstSeen.keys()) {
    if (!activeKeys.has(key)) {
      sessionFirstSeen.delete(key);
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

      // Poll servers every 5 seconds (fallback / reconciliation when realtime
      // is disabled or a socket is down)
      const pollTimer = setInterval(poll, POLL_INTERVAL);

      // Real-time: push within ~EVENT_POLL_MIN_MS of any session change pushed
      // by a media-server WebSocket, instead of waiting for the next poll tick.
      let lastEventPoll = 0;
      let trailingTimer: ReturnType<typeof setTimeout> | null = null;
      const onRealtimeSession = () => {
        if (closed) return;
        const now = Date.now();
        const elapsed = now - lastEventPoll;
        if (elapsed >= EVENT_POLL_MIN_MS) {
          lastEventPoll = now;
          void poll();
        } else if (!trailingTimer) {
          trailingTimer = setTimeout(() => {
            trailingTimer = null;
            lastEventPoll = Date.now();
            void poll();
          }, EVENT_POLL_MIN_MS - elapsed);
        }
      };
      const realtimeUnsub = realtimeBus.subscribe((event) => {
        if (event.kind === "session-changed") onRealtimeSession();
      });

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
          realtimeUnsub();
          if (trailingTimer) clearTimeout(trailingTimer);
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
