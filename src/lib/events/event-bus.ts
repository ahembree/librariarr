import { EventEmitter } from "events";

export type AppEventType =
  | "sync:started"
  | "sync:completed"
  | "sync:failed"
  | "lifecycle:detection-completed"
  | "lifecycle:action-executed"
  | "settings:changed"
  | "server:changed";

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
