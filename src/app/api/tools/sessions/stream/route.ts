import { withSession } from "@/lib/auth/with-session";
import { realtimeBus } from "@/lib/media-server/realtime";
import { readSessionsSnapshot, type SessionWithServer } from "../snapshot";

export const dynamic = "force-dynamic";

// Minimum spacing between realtime-triggered polls. A playing stream emits
// session events ~every second, so without this the socket would drive one
// getSessions() per second per active stream — worse than plain polling.
const EVENT_POLL_MIN_MS = 2000;

const POLL_INTERVAL = 5000;
// Under the 30s idle timeout common to reverse proxies, which a 30s heartbeat
// raced: the proxy closed the stream just before each heartbeat arrived.
const HEARTBEAT_INTERVAL = 15000;
const MAX_STREAM_LIFETIME = 3600000; // 1 hour safety limit

/**
 * The sessions, from the poll every open stream shares (`readSessionsSnapshot`):
 * each connection polled every server on its own 5-second tick. A pushed
 * change is noted there before any stream hears of it, so a realtime-triggered
 * poll is never handed one that began before the change.
 */
async function fetchAllSessions(userId: string): Promise<SessionWithServer[]> {
  return (await readSessionsSnapshot(userId)).sessions;
}

// Both transcode decisions are included: a paused stream has a frozen
// viewOffset and unchanged state, so an audio-decision flip would otherwise
// never reach the client.
function sessionsFingerprint(sessions: SessionWithServer[]): string {
  return sessions
    .map(
      (s) =>
        `${s.serverId}:${s.sessionId}:${s.player.state}:${s.viewOffset ?? 0}:${s.transcoding?.videoDecision ?? ""}:${s.transcoding?.audioDecision ?? ""}:${s.transcoding?.speed ?? ""}`
    )
    .sort()
    .join("|");
}

export const GET = withSession(async (session) => {
  const userId = session.userId;
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
      // Every open stream hears the same push and shares the one poll it
      // causes (see `readSessionsSnapshot`).
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
});
