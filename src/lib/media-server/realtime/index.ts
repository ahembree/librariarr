import { logger } from "@/lib/logger";
import { eventBus } from "@/lib/events/event-bus";
import { RealtimeManager } from "./manager";

const RECONCILE_INTERVAL_MS = 60_000;

interface RealtimeState {
  manager: RealtimeManager;
  started: boolean;
  interval: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

// Pinned to globalThis so dev HMR / repeated instrumentation registration reuse
// the same manager instead of leaking parallel connection sets.
const globalForRealtime = globalThis as unknown as {
  __librariarrRealtime?: RealtimeState;
};

function getState(): RealtimeState {
  if (!globalForRealtime.__librariarrRealtime) {
    globalForRealtime.__librariarrRealtime = {
      manager: new RealtimeManager(),
      started: false,
      interval: null,
      unsubscribe: null,
    };
  }
  return globalForRealtime.__librariarrRealtime;
}

export function getRealtimeManager(): RealtimeManager {
  return getState().manager;
}

/**
 * Start the media-server realtime manager: open a WebSocket per enabled server,
 * reconcile on server/settings changes, and keep a periodic safety reconcile.
 * Idempotent — safe to call from instrumentation on every boot.
 */
export function startRealtime(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;

  // Reconcile the connection set whenever servers or the realtime toggle change.
  state.unsubscribe = eventBus.subscribe((event) => {
    if (event.type === "server:changed" || event.type === "settings:changed") {
      state.manager
        .reconcile()
        .catch((error) => logger.debug("Realtime", "Reconcile after event failed", { error: String(error) }));
    }
  });

  // Safety net for missed events (a config change that forgot to emit, or a
  // server that came back online): re-diff every minute.
  state.interval = setInterval(() => {
    void state.manager.reconcile();
  }, RECONCILE_INTERVAL_MS);

  void state.manager
    .reconcile()
    .catch((error) => logger.error("Realtime", "Initial reconcile failed", { error: String(error) }));

  logger.info("Realtime", "Media-server realtime manager started");
}

/** Reset all realtime state. Test-only. */
export function _resetRealtimeForTesting(): void {
  const state = globalForRealtime.__librariarrRealtime;
  if (state) {
    if (state.interval) clearInterval(state.interval);
    if (state.unsubscribe) state.unsubscribe();
    state.manager.stopAll();
  }
  globalForRealtime.__librariarrRealtime = undefined;
}

export { realtimeBus } from "./bus";
export { RealtimeManager } from "./manager";
export type {
  RealtimeEvent,
  RealtimeEventKind,
  RealtimeConnectionStatus,
  RealtimeServerConfig,
} from "./types";
