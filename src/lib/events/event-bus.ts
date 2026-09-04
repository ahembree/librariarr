import { EventEmitter } from "events";

export type AppEventType =
  | "sync:started"
  | "sync:completed"
  | "sync:failed"
  | "lifecycle:detection-completed"
  | "lifecycle:action-executed"
  | "settings:changed"
  | "server:changed"
  /**
   * A Tracearr import wrote plays for a server (`meta.serverId`).
   *
   * Carries no figures on purpose — the receiver refetches
   * `/api/integrations/tracearr/status`, which is the one place the import
   * readout is computed. Emitting the numbers here would mean deriving them a
   * second time, in the importer, where they could silently disagree with what
   * the settings page shows for the same server.
   *
   * Throttled by the emitter, because the archive walk commits a page roughly
   * every second over thousands of pages and each event costs the receiver a
   * status query.
   */
  | "tracearr:import-progress";

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
