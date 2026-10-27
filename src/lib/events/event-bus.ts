import { EventEmitter } from "events";
import { logger } from "@/lib/logger";

export type AppEventType =
  | "sync:started"
  /**
   * A sync finished and changed the dataset (`meta`: `SyncCompletedMeta` —
   * `serverId`, and `libraryTypes` when the run knows which library types it
   * touched; absent means "refetch as before").
   */
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
  | "tracearr:import-progress"
  /**
   * A server's stored `WatchHistory` changed (`meta.serverId`).
   *
   * Separate from `sync:completed` on purpose. That event means the library was
   * re-scanned and sixteen subscribers respond by refetching whole media
   * listings; this one means only that plays moved, which concerns the History
   * page, the watch statistics and the per-item play lists. Reusing
   * `sync:completed` would make every library page re-pull tens of thousands of
   * rows once per backfill slice, for the hours an archive walk takes.
   *
   * Also distinct from `tracearr:import-progress`, which says an import is in
   * flight and drives only the "still importing" notice. This one says the data
   * is different and should be re-read.
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
  | "session-changed"
  /**
   * A display setting the authenticated shell renders was saved (chip colours,
   * table columns, card display options, the dashboard layout, the accent,
   * the "What's new" version).
   *
   * Carries nothing: every open tab refetches `/api/settings/shell`, the one
   * place those values are read. The layout renders them only on a full page
   * load, so without this a second tab or device kept the values it loaded and
   * its next save overwrote the newer ones.
   */
  | "display-settings:changed";

export interface AppEvent {
  type: AppEventType;
  userId: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

type AppEventListener = (event: AppEvent) => void;

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
    // EventEmitter calls listeners in turn and stops at the first that throws,
    // so one broken subscriber (the realtime manager, an SSE stream) would
    // silently cost every subscriber after it the event. Each is isolated.
    const isolated: AppEventListener = (event) => {
      try {
        listener(event);
      } catch (error) {
        logger.error("Events", `A "${event.type}" listener threw; the other listeners still received it`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.emitter.on(EVENT_KEY, isolated);
    return () => {
      this.emitter.removeListener(EVENT_KEY, isolated);
    };
  }

  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_KEY);
  }
}

// Pinned to globalThis unconditionally, not only in development: the job worker
// and the realtime manager started from instrumentation load their own copy of
// this module, so a production build pinned to nothing had two buses, and
// nothing they emitted (a background sync's progress and result, Tracearr
// import progress, a media server's connection state) reached
// /api/events/stream.
const globalForEventBus = globalThis as unknown as {
  eventBus: AppEventBus | undefined;
};

export const eventBus = (globalForEventBus.eventBus ??= new AppEventBus());
