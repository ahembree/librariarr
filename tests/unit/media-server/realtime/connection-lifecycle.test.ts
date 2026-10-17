import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ logger }));

import { ServerRealtimeConnection } from "@/lib/media-server/realtime/connection";
import type { RealtimeSocket, SocketFactory } from "@/lib/media-server/realtime/socket";
import type { RealtimeEvent, RealtimeServerConfig } from "@/lib/media-server/realtime/types";

class FakeSocket implements RealtimeSocket {
  sent: string[] = [];
  pings = 0;
  closeCalls = 0;
  private openCb: (() => void) | null = null;
  private msgCb: ((d: string) => void) | null = null;
  private closeCb: ((c: number, r: string) => void) | null = null;
  private errCb: ((e: Error) => void) | null = null;

  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closeCalls++;
  }
  ping() {
    this.pings++;
  }
  onOpen(cb: () => void) {
    this.openCb = cb;
  }
  onMessage(cb: (d: string) => void) {
    this.msgCb = cb;
  }
  onClose(cb: (c: number, r: string) => void) {
    this.closeCb = cb;
  }
  onError(cb: (e: Error) => void) {
    this.errCb = cb;
  }

  fireOpen() {
    this.openCb?.();
  }
  fireMessage(obj: unknown) {
    this.msgCb?.(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  fireClose(code = 1006, reason = "") {
    this.closeCb?.(code, reason);
  }
  fireError(err: unknown) {
    this.errCb?.(err as Error);
  }
}

function config(overrides: Partial<RealtimeServerConfig> = {}): RealtimeServerConfig {
  return {
    id: "srv",
    name: "Server",
    type: "PLEX",
    url: "http://media:32400",
    accessToken: "tok",
    tlsSkipVerify: false,
    userId: "user-1",
    ...overrides,
  };
}

describe("ServerRealtimeConnection — lifecycle edges", () => {
  let events: RealtimeEvent[];
  let statuses: string[];
  let sockets: FakeSocket[];
  let factoryCalls: Array<Parameters<SocketFactory>>;
  let factory: SocketFactory;

  const callbacks = () => ({
    onEvent: (e: RealtimeEvent) => events.push(e),
    onStatus: (_id: string, s: string) => statuses.push(s),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    logger.debug.mockClear();
    events = [];
    statuses = [];
    sockets = [];
    factoryCalls = [];
    factory = (url, options) => {
      factoryCalls.push([url, options]);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
  });
  afterEach(() => vi.useRealTimers());

  it("passes the TLS setting and auth headers to the socket factory", () => {
    new ServerRealtimeConnection(config({ type: "EMBY", tlsSkipVerify: true }), callbacks(), factory).start();
    const [url, options] = factoryCalls[0];
    expect(url).toBe("ws://media:32400/embywebsocket?api_key=tok&deviceId=librariarr");
    expect(options).toEqual({ rejectUnauthorized: false, headers: { "X-Emby-Token": "tok" } });
  });

  it("gives up without reconnecting on a server type with no realtime transport", () => {
    const conn = new ServerRealtimeConnection(
      config({ type: "KODI" as never }),
      callbacks(),
      factory,
    );
    conn.start();
    expect(statuses).toEqual(["connecting", "disconnected"]);
    expect(factoryCalls).toHaveLength(0);
    vi.advanceTimersByTime(120_000);
    expect(factoryCalls).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'No realtime transport for "Server"', expect.any(Object));
  });

  it("retries with backoff when the socket factory throws, capped at 60s", () => {
    let throwsLeft = 8;
    const flaky: SocketFactory = (url, options) => {
      if (throwsLeft-- > 0) throw new Error("ECONNREFUSED");
      return factory(url, options);
    };
    new ServerRealtimeConnection(config(), callbacks(), flaky).start();
    expect(sockets).toHaveLength(0);

    // 1s, 2s, 4s, 8s, 16s, 32s, then capped at 60s (not 64s), then 60s.
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    let attempts = 0;
    for (const delay of delays) {
      vi.advanceTimersByTime(delay - 1);
      expect(throwsLeft).toBe(8 - 1 - attempts);
      vi.advanceTimersByTime(1);
      attempts++;
    }
    expect(sockets).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'Failed to open socket for "Server"', {
      error: "Error: ECONNREFUSED",
    });
  });

  it("start() after stop() does nothing", () => {
    const conn = new ServerRealtimeConnection(config(), callbacks(), factory);
    conn.stop();
    conn.start();
    expect(factoryCalls).toHaveLength(0);
    // stop() on a connection that never connected reports nothing new.
    expect(statuses).toEqual([]);
  });

  it("stop() cancels a pending reconnect", () => {
    const conn = new ServerRealtimeConnection(config(), callbacks(), factory);
    conn.start();
    sockets[0].fireClose(1006, "network");
    expect(statuses).toEqual(["connecting", "disconnected"]);
    conn.stop();
    vi.advanceTimersByTime(120_000);
    expect(factoryCalls).toHaveLength(1);
  });

  it("closes a socket that opens after stop() without reporting connected", () => {
    const conn = new ServerRealtimeConnection(config(), callbacks(), factory);
    conn.start();
    const socket = sockets[0];
    conn.stop();
    expect(socket.closeCalls).toBe(1);
    socket.fireOpen();
    expect(socket.closeCalls).toBe(2);
    expect(statuses).not.toContain("connected");
    expect(events.some((e) => e.kind === "session-changed")).toBe(false);

    // The close that follows reports disconnected (already) and never reconnects.
    socket.fireClose(1000, "bye");
    vi.advanceTimersByTime(120_000);
    expect(factoryCalls).toHaveLength(1);
  });

  it("logs a socket error quietly and leaves reconnecting to the close", () => {
    new ServerRealtimeConnection(config(), callbacks(), factory).start();
    sockets[0].fireError(new Error("boom"));
    sockets[0].fireError("plain string");
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'Socket error for "Server"', { error: "boom" });
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'Socket error for "Server"', { error: "plain string" });
    vi.advanceTimersByTime(120_000);
    expect(factoryCalls).toHaveLength(1);
  });

  it("includes the close reason in the disconnect log only when one is given", () => {
    new ServerRealtimeConnection(config(), callbacks(), factory).start();
    sockets[0].fireOpen();
    sockets[0].fireClose(1001, "going away");
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'Disconnected from "Server" (code 1001, going away)');
    vi.advanceTimersByTime(1000);
    sockets[1].fireClose(1006, "");
    expect(logger.debug).toHaveBeenCalledWith("Realtime", 'Disconnected from "Server" (code 1006)');
  });

  it("Emby subscribes on open, answers KeepAlive prompts and sends keepalives on the interval", () => {
    new ServerRealtimeConnection(config({ type: "EMBY" }), callbacks(), factory).start();
    const socket = sockets[0];
    socket.fireOpen();
    expect(socket.sent).toEqual([JSON.stringify({ MessageType: "SessionsStart", Data: "0,1500" })]);

    events.length = 0;
    socket.fireMessage({ MessageType: "KeepAlive" });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ MessageType: "KeepAlive" }));
    expect(events).toEqual([]);

    vi.advanceTimersByTime(30_000);
    expect(socket.sent.filter((m) => m.includes('"KeepAlive"'))).toHaveLength(2);
    expect(socket.pings).toBe(0);
  });

  it("stops the keepalive when the socket closes and sends nothing on a dead socket", () => {
    new ServerRealtimeConnection(config({ type: "JELLYFIN" }), callbacks(), factory).start();
    const socket = sockets[0];
    socket.fireOpen();
    const sentAtClose = socket.sent.length;
    socket.fireClose();
    vi.advanceTimersByTime(30_000 * 3 - 1000);
    // The old socket got nothing more, and neither did its replacement — still
    // connecting, which a surviving interval would have sent KeepAlives to.
    expect(socket.sent).toHaveLength(sentAtClose);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([]);
  });

  it("passes non-Sessions Jellyfin frames through the normalizer every time", () => {
    new ServerRealtimeConnection(config({ type: "JELLYFIN" }), callbacks(), factory).start();
    const socket = sockets[0];
    socket.fireOpen();
    events.length = 0;
    const frame = {
      MessageType: "UserDataChanged",
      Data: {
        UserId: "6c1e2d3f4a5b4c6d8e9f0a1b2c3d4e5f",
        UserDataList: [{ ItemId: "2c1f4d0e9a8b4c3d8e7f6a5b4c3d2e1f", Played: true, PlayCount: 1, Key: "2c1f4d0e9a8b4c3d8e7f6a5b4c3d2e1f" }],
      },
    };
    socket.fireMessage(frame);
    socket.fireMessage(frame);
    const watch = events.filter((e) => e.kind === "watch-changed");
    expect(watch).toHaveLength(2);
    // A JSON scalar is not a record; normalizers yield nothing for it.
    events.length = 0;
    socket.fireMessage("42");
    expect(events).toEqual([]);
  });
});
