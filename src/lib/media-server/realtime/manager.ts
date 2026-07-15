import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY } from "@/lib/jobs/constants";
import { runEnforcerTick } from "@/lib/maintenance/enforcer";
import type { MediaServerType } from "@/generated/prisma/client";
import { realtimeBus } from "./bus";
import { Debouncer } from "./debounce";
import { Throttle } from "./throttle";
import { ServerRealtimeConnection } from "./connection";
import { wsSocketFactory, type SocketFactory } from "./socket";
import type { RealtimeEvent, RealtimeServerConfig, RealtimeConnectionStatus } from "./types";

// A library scan emits a burst of change events; coalesce them into one sync
// after the scan goes quiet, but never wait longer than the max.
const LIBRARY_SYNC_QUIET_MS = 30_000;
const LIBRARY_SYNC_MAX_MS = 5 * 60_000;
const WATCH_SYNC_QUIET_MS = 30_000;
const WATCH_SYNC_MAX_MS = 5 * 60_000;
// New sessions must be *seen* fast (so their termination delay starts promptly).
// A leading-edge throttle runs the enforcer immediately on the first change, then
// floors subsequent runs to once per interval — so a server that keeps pushing
// session frames (Plex progress notifications, or a not-yet-suppressed frame)
// can't drive the enforcer (which calls getSessions on every server) in a loop.
const ENFORCER_MIN_INTERVAL_MS = 2_000;

/** Identity of a server's connection config — a change forces a reconnect. */
function connectionSignature(s: RealtimeServerConfig): string {
  return `${s.type}|${s.url}|${s.accessToken}|${s.tlsSkipVerify}`;
}

interface ManagedConnection {
  conn: ServerRealtimeConnection;
  signature: string;
  status: RealtimeConnectionStatus;
  config: RealtimeServerConfig;
}

export interface RealtimeStatusEntry {
  serverId: string;
  name: string;
  type: MediaServerType;
  status: RealtimeConnectionStatus;
}

/**
 * Owns one {@link ServerRealtimeConnection} per enabled media server and routes
 * their normalized events to debounced side effects (enforcer tick, incremental
 * sync, watch-history refresh) plus the in-process {@link realtimeBus}.
 *
 * Connections are keyed by `MediaServer.id`, so several servers of the same
 * type (multiple Plex / Jellyfin / Emby instances) each get an independent
 * connection. `reconcile()` diffs the DB's enabled-server set against the live
 * connections and opens/closes/recycles as needed; it also honors the
 * `AppSettings.realtimeSync` master switch.
 */
export class RealtimeManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly syncDebouncers = new Map<string, Debouncer>();
  private readonly watchDebouncers = new Map<string, Debouncer>();
  private readonly enforcerThrottle: Throttle;
  private readonly socketFactory: SocketFactory;
  private reconciling = false;
  private reconcileRequested = false;

  constructor(socketFactory: SocketFactory = wsSocketFactory) {
    this.socketFactory = socketFactory;
    this.enforcerThrottle = new Throttle(() => {
      runEnforcerTick().catch((error) =>
        logger.debug("Realtime", "Enforcer tick failed", { error: String(error) }),
      );
    }, ENFORCER_MIN_INTERVAL_MS);
  }

  /**
   * Bring the live connection set in line with the DB. Idempotent. Concurrent
   * calls are coalesced: a request that arrives during an in-flight run isn't
   * dropped — it's marked pending and the loop runs one more pass with fresh DB
   * state, so a server/settings change mid-reconcile takes effect immediately
   * instead of waiting for the 60s safety pass.
   */
  async reconcile(): Promise<void> {
    this.reconcileRequested = true;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      while (this.reconcileRequested) {
        this.reconcileRequested = false;
        await this.runReconcile();
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async runReconcile(): Promise<void> {
    try {
      const enabled = await this.isRealtimeEnabled();
      const servers = enabled ? await this.loadServers() : [];
      const wanted = new Map(servers.map((s) => [s.id, s]));

      // Drop connections that are gone, disabled, or whose config changed.
      for (const [id, managed] of this.connections) {
        const want = wanted.get(id);
        if (!want || connectionSignature(want) !== managed.signature) {
          managed.conn.stop();
          this.connections.delete(id);
          this.disposeDebouncers(id);
        }
      }

      // Open connections for newly-wanted servers.
      for (const server of servers) {
        if (this.connections.has(server.id)) continue;
        const conn = new ServerRealtimeConnection(
          server,
          {
            onEvent: (event) => this.handleEvent(event),
            onStatus: (serverId, status) => {
              const managed = this.connections.get(serverId);
              if (managed) managed.status = status;
            },
          },
          this.socketFactory,
        );
        this.connections.set(server.id, {
          conn,
          signature: connectionSignature(server),
          status: "connecting",
          config: server,
        });
        conn.start();
      }
    } catch (error) {
      logger.error("Realtime", "Reconcile failed", { error: String(error) });
    }
  }

  /** Current per-server connection status (for the status API / UI indicator). */
  getStatuses(): RealtimeStatusEntry[] {
    return [...this.connections.values()].map((m) => ({
      serverId: m.config.id,
      name: m.config.name,
      type: m.config.type,
      status: m.status,
    }));
  }

  /** Tear down every connection and pending side effect (shutdown / tests). */
  stopAll(): void {
    for (const [id, managed] of this.connections) {
      managed.conn.stop();
      this.disposeDebouncers(id);
    }
    this.connections.clear();
    this.enforcerThrottle.cancel();
  }

  private handleEvent(event: RealtimeEvent): void {
    realtimeBus.emit(event);

    switch (event.kind) {
      case "session-changed":
        // Run the maintenance/blackout/transcode enforcer so a new stream is
        // seen (and its termination clock started) promptly instead of after
        // ~30s. Leading-edge throttle: immediate on a real change, floored so a
        // server that keeps pushing session frames can't drive it in a loop.
        this.enforcerThrottle.trigger();
        break;
      case "library-changed":
        this.getSyncDebouncer(event.serverId).trigger();
        break;
      case "watch-changed":
        this.getWatchDebouncer(event.serverId).trigger();
        break;
      case "server-status":
        break;
    }
  }

  private getSyncDebouncer(serverId: string): Debouncer {
    let debouncer = this.syncDebouncers.get(serverId);
    if (!debouncer) {
      debouncer = new Debouncer(
        () => {
          // Same jobKey as the scheduled dispatcher so a realtime-triggered sync
          // and a scheduled one dedupe into a single queued job.
          void enqueueJob(
            TASK_SYNC_SERVER,
            { serverId },
            { jobKey: `sync:${serverId}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
          ).then((ok) => {
            if (ok) logger.info("Realtime", `Enqueued incremental sync for server ${serverId} (library changed)`);
          });
        },
        { quietMs: LIBRARY_SYNC_QUIET_MS, maxWaitMs: LIBRARY_SYNC_MAX_MS },
      );
      this.syncDebouncers.set(serverId, debouncer);
    }
    return debouncer;
  }

  private getWatchDebouncer(serverId: string): Debouncer {
    let debouncer = this.watchDebouncers.get(serverId);
    if (!debouncer) {
      debouncer = new Debouncer(
        () => {
          void enqueueJob(
            TASK_SYNC_WATCH_HISTORY,
            { serverId },
            { jobKey: `watch-history:${serverId}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
          ).then((ok) => {
            if (ok) logger.info("Realtime", `Enqueued watch-history refresh for server ${serverId} (watch state changed)`);
          });
        },
        { quietMs: WATCH_SYNC_QUIET_MS, maxWaitMs: WATCH_SYNC_MAX_MS },
      );
      this.watchDebouncers.set(serverId, debouncer);
    }
    return debouncer;
  }

  private disposeDebouncers(serverId: string): void {
    this.syncDebouncers.get(serverId)?.cancel();
    this.syncDebouncers.delete(serverId);
    this.watchDebouncers.get(serverId)?.cancel();
    this.watchDebouncers.delete(serverId);
  }

  private async isRealtimeEnabled(): Promise<boolean> {
    try {
      const settings = await prisma.appSettings.findFirst({ select: { realtimeSync: true } });
      // Default on when no settings row exists yet (pre-setup: no servers anyway).
      return settings?.realtimeSync ?? true;
    } catch (error) {
      logger.debug("Realtime", "Could not read realtime setting; treating as disabled", {
        error: String(error),
      });
      return false;
    }
  }

  private async loadServers(): Promise<RealtimeServerConfig[]> {
    return prisma.mediaServer.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        type: true,
        url: true,
        accessToken: true,
        tlsSkipVerify: true,
      },
    });
  }
}
