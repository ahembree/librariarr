import { logger } from "@/lib/logger";
import type { RealtimeEvent, RealtimeServerConfig, RealtimeConnectionStatus } from "./types";
import {
  buildRealtimeUrl,
  buildRealtimeHeaders,
  wsSocketFactory,
  type SocketFactory,
  type RealtimeSocket,
} from "./socket";
import { normalizePlexMessage } from "./normalize-plex";
import { normalizeJellyfinMessage, jellyfinSessionsSignature } from "./normalize-jellyfin";
import { isRecord } from "./normalize-util";

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const KEEPALIVE_MS = 30_000;

export interface ConnectionCallbacks {
  onEvent(event: RealtimeEvent): void;
  onStatus(serverId: string, status: RealtimeConnectionStatus): void;
}

/**
 * A single, self-healing WebSocket connection to one media server.
 *
 * Owns the connect → open → (message*) → close → reconnect lifecycle with
 * exponential backoff. On open it subscribes (Jellyfin/Emby need an explicit
 * `SessionsStart`; Plex pushes automatically), starts a keepalive, and emits an
 * initial `session-changed` so the current state is captured immediately. All
 * inbound frames are parsed and handed to the per-type normalizer; the
 * resulting canonical events flow to `onEvent`.
 */
export class ServerRealtimeConnection {
  readonly config: RealtimeServerConfig;
  private readonly cb: ConnectionCallbacks;
  private readonly socketFactory: SocketFactory;

  private socket: RealtimeSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private status: RealtimeConnectionStatus = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Last Jellyfin/Emby `Sessions` signature, to drop redundant periodic frames.
  private lastSessionsSignature: string | null = null;

  constructor(
    config: RealtimeServerConfig,
    cb: ConnectionCallbacks,
    socketFactory: SocketFactory = wsSocketFactory,
  ) {
    this.config = config;
    this.cb = cb;
    this.socketFactory = socketFactory;
  }

  getStatus(): RealtimeConnectionStatus {
    return this.status;
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setStatus("disconnected");
  }

  private setStatus(status: RealtimeConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.cb.onStatus(this.config.id, status);
    this.cb.onEvent({
      kind: "server-status",
      serverId: this.config.id,
      serverType: this.config.type,
      at: Date.now(),
      status,
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");

    let url: string;
    try {
      url = buildRealtimeUrl(this.config.type, this.config.url, this.config.accessToken);
    } catch (err) {
      // Unsupported server type — give up (no reconnect); nothing to retry.
      logger.debug("Realtime", `No realtime transport for "${this.config.name}"`, { error: String(err) });
      this.setStatus("disconnected");
      return;
    }

    const headers = buildRealtimeHeaders(this.config.type, this.config.accessToken);

    let socket: RealtimeSocket;
    try {
      socket = this.socketFactory(url, {
        rejectUnauthorized: !this.config.tlsSkipVerify,
        headers,
      });
    } catch (err) {
      logger.debug("Realtime", `Failed to open socket for "${this.config.name}"`, { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onOpen(() => {
      if (this.stopped) {
        socket.close();
        return;
      }
      this.attempt = 0;
      this.setStatus("connected");
      logger.info("Realtime", `Connected to "${this.config.name}" (${this.config.type})`);
      this.subscribeOnOpen(socket);
      this.startKeepalive(socket);
      // Capture current state immediately rather than waiting for the first push.
      this.cb.onEvent({
        kind: "session-changed",
        serverId: this.config.id,
        serverType: this.config.type,
        at: Date.now(),
        detail: { reason: "connected" },
      });
    });

    socket.onMessage((data) => this.handleMessage(data));

    socket.onError((err) => {
      // A `close` always follows an error; the reconnect is scheduled there so
      // we don't double-schedule. Log quietly to avoid spamming a down server.
      logger.debug("Realtime", `Socket error for "${this.config.name}"`, {
        error: String(err?.message ?? err),
      });
    });

    socket.onClose((code, reason) => {
      this.stopKeepalive();
      this.socket = null;
      if (this.stopped) {
        this.setStatus("disconnected");
        return;
      }
      this.setStatus("disconnected");
      logger.debug(
        "Realtime",
        `Disconnected from "${this.config.name}" (code ${code}${reason ? `, ${reason}` : ""})`,
      );
      this.scheduleReconnect();
    });
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Non-JSON frame — ignore.
    }

    // Jellyfin/Emby: reply to keepalive prompts and never surface them as events.
    if (this.config.type === "JELLYFIN" || this.config.type === "EMBY") {
      if (isRecord(parsed) && (parsed.MessageType === "ForceKeepAlive" || parsed.MessageType === "KeepAlive")) {
        this.sendKeepAlive();
        return;
      }
      // The SessionsStart subscription pushes a full frame on a fixed period even
      // when nothing changed (and position ticks every frame). Drop frames whose
      // meaningful session state is unchanged, so the enforcer/sessions consumers
      // only wake on a real change instead of ~every 1.5s forever.
      if (isRecord(parsed) && parsed.MessageType === "Sessions") {
        const signature = jellyfinSessionsSignature(parsed.Data);
        if (signature === this.lastSessionsSignature) return;
        this.lastSessionsSignature = signature;
      }
    }

    const events =
      this.config.type === "PLEX"
        ? normalizePlexMessage(parsed, { serverId: this.config.id })
        : normalizeJellyfinMessage(parsed, { serverId: this.config.id, serverType: this.config.type });

    for (const event of events) this.cb.onEvent(event);
  }

  private subscribeOnOpen(socket: RealtimeSocket): void {
    if (this.config.type === "JELLYFIN" || this.config.type === "EMBY") {
      // Subscribe to session updates: "dueTime,period" in ms. LibraryChanged and
      // UserDataChanged are broadcast without an explicit subscription.
      socket.send(JSON.stringify({ MessageType: "SessionsStart", Data: "0,1500" }));
    }
    // Plex requires no subscription — it starts pushing on connect.
  }

  private startKeepalive(socket: RealtimeSocket): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.config.type === "PLEX") {
        socket.ping();
      } else {
        this.sendKeepAlive();
      }
    }, KEEPALIVE_MS);
  }

  private sendKeepAlive(): void {
    this.socket?.send(JSON.stringify({ MessageType: "KeepAlive" }));
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
