import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { eventBus } from "@/lib/events/event-bus";
import type { AppEvent } from "@/lib/events/event-bus";

export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL = 30000;
const MAX_STREAM_LIFETIME = 3600000; // 1 hour safety limit

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.userId!;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      // Subscribe to the event bus, filtering by userId
      const unsubscribe = eventBus.subscribe((event: AppEvent) => {
        if (event.userId !== userId) return;
        send(event.type, { timestamp: event.timestamp, ...event.meta });
      });

      // Send initial connected event
      send("connected", { timestamp: Date.now() });

      // Heartbeat to keep connection alive
      const heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_INTERVAL);

      // Safety net: close after max lifetime
      const maxLifetimeTimer = setTimeout(() => {
        closed = true;
      }, MAX_STREAM_LIFETIME);

      // Cleanup when client disconnects
      const checkClosed = setInterval(() => {
        if (closed) {
          unsubscribe();
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
