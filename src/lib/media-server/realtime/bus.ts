import { EventEmitter } from "events";
import type { RealtimeEvent } from "./types";

/**
 * In-process pub/sub for normalized media-server real-time events.
 *
 * Separate from the app-level `eventBus` (`@/lib/events/event-bus`): those
 * events are low-frequency app milestones (sync/lifecycle) fanned out to the
 * browser over SSE, whereas these are high-frequency, server-scoped signals
 * consumed in-process (the sessions stream, the enforcer trigger). Keeping them
 * apart avoids polluting the app event union and its per-user SSE fan-out.
 */
export type RealtimeListener = (event: RealtimeEvent) => void;

const EVENT_KEY = "realtime-event";

class RealtimeBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    // One listener per open SSE session + a few in-process consumers; keep the
    // ceiling generous so an active dashboard never trips the leak warning.
    this.emitter.setMaxListeners(200);
  }

  emit(event: RealtimeEvent): void {
    try {
      this.emitter.emit(EVENT_KEY, event);
    } catch {
      // Fire-and-forget — a throwing listener must never break the producer.
    }
  }

  subscribe(listener: RealtimeListener): () => void {
    this.emitter.on(EVENT_KEY, listener);
    return () => {
      this.emitter.removeListener(EVENT_KEY, listener);
    };
  }

  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_KEY);
  }
}

// Singleton pinned to globalThis so Next.js dev HMR (which re-evaluates modules)
// doesn't spawn a second bus that producers and consumers can't see each other on.
const globalForRealtimeBus = globalThis as unknown as {
  realtimeBus: RealtimeBus | undefined;
};

export const realtimeBus = globalForRealtimeBus.realtimeBus ?? new RealtimeBus();

if (process.env.NODE_ENV !== "production") globalForRealtimeBus.realtimeBus = realtimeBus;
