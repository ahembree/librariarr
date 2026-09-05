import { EventEmitter } from "events";

export type AppEventType =
  | "sync:started"
  | "sync:completed"
  /**
   * A running sync committed a batch (`meta.serverId`).
   *
   * Throttled to 2s per server by the emitter, and carries no figures — the
   * receiver refetches `/api/sync/status`, which stays the single place
   * progress is computed.
   *
   * Exists so the three surfaces that render sync progress stop polling every
   * 2 seconds for the whole 90–240s of a sync. Before it, that poll was the
   * only way to see a sync advance, and it was the heaviest in the app.
   */
  | "sync:progress"
  | "sync:failed"
  | "lifecycle:detection-completed"
  | "lifecycle:action-executed"
  | "settings:changed"
  | "server:changed"
  /**
   * A server's stored `WatchHistory` changed (`meta.serverId`).
   *
   * Separate from `sync:completed` on purpose. That event means the library was
   * re-scanned and sixteen subscribers respond by refetching whole media
   * listings; this one means only that plays moved, which concerns the History
   * page, the watch statistics and the per-item play lists. Reusing
   * `sync:completed` would make every library page re-pull tens of thousands of
   * rows once per backfill slice, for the hours an archive walk takes.
   */
  | "watch-history:updated"
  /**
   * A media server's realtime connection changed state (`meta.serverId`,
   * `meta.connected`).
   *
   * Bridged from `realtimeBus`, which is server-side only. The connection layer
   * knows the instant a socket drops or recovers, but until this existed the
   * browser could only infer it from the sidebar's 30s session poll failing.
   *
   * Emitted only on an actual state transition, so a server that is simply
   * down does not produce one browser event per failed reconnect attempt.
   */
  | "server-status"
  /**
   * An active playback session started, stopped or changed (`meta.serverId`).
   *
   * Bridged from `realtimeBus`, throttled to 2s per server. Exists so the
   * sidebar's stream badge updates on a push instead of a 30s poll that
   * round-trips to every media server just to count sessions.
   *
   * Carries no session data — the receiver refetches the route that owns it.
   */
  | "session-changed";

export interface AppEvent {
  type: AppEventType;
  userId: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export type AppEventListener = (event: AppEvent) => void;

const EVENT_KEY = "app-event";

class AppEventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
  }

  emit(event: Omit<AppEvent, "timestamp">) {
    try {
      this.emitter.emit(EVENT_KEY, { ...event, timestamp: Date.now() });
    } catch {
      // Fire-and-forget — never let event emission break the caller
    }
  }

  subscribe(listener: AppEventListener): () => void {
    this.emitter.on(EVENT_KEY, listener);
    return () => {
      this.emitter.removeListener(EVENT_KEY, listener);
    };
  }

  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_KEY);
  }
}

const globalForEventBus = globalThis as unknown as {
  eventBus: AppEventBus | undefined;
};

export const eventBus = globalForEventBus.eventBus ?? new AppEventBus();

if (process.env.NODE_ENV !== "production") globalForEventBus.eventBus = eventBus;
