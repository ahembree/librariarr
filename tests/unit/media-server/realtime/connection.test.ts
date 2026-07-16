import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ServerRealtimeConnection } from "@/lib/media-server/realtime/connection";
import type { RealtimeSocket, SocketFactory } from "@/lib/media-server/realtime/socket";
import type { RealtimeEvent, RealtimeServerConfig } from "@/lib/media-server/realtime/types";

class FakeSocket implements RealtimeSocket {
  sent: string[] = [];
  pings = 0;
  closed = false;
  private openCb: (() => void) | null = null;
  private msgCb: ((d: string) => void) | null = null;
  private closeCb: ((c: number, r: string) => void) | null = null;
  private errCb: ((e: Error) => void) | null = null;

  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
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

  // --- test drivers ---
  fireOpen() {
    this.openCb?.();
  }
  fireMessage(obj: unknown) {
    this.msgCb?.(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  fireClose(code = 1006) {
    this.closeCb?.(code, "gone");
  }
  fireError() {
    this.errCb?.(new Error("err"));
  }
}

function makeFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

const plexConfig: RealtimeServerConfig = {
  id: "s1",
  name: "Plex",
  type: "PLEX",
  url: "http://plex:32400",
  accessToken: "t",
  tlsSkipVerify: false,
};
const jfConfig: RealtimeServerConfig = {
  id: "s2",
  name: "JF",
  type: "JELLYFIN",
  url: "http://jf:8096",
  accessToken: "t",
  tlsSkipVerify: false,
};

describe("ServerRealtimeConnection", () => {
  let events: RealtimeEvent[];
  let statuses: Array<[string, string]>;
  const callbacks = () => ({
    onEvent: (e: RealtimeEvent) => events.push(e),
    onStatus: (id: string, s: string) => statuses.push([id, s]),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    statuses = [];
  });
  afterEach(() => vi.useRealTimers());

  it("subscribes on open (Jellyfin) and reports connected + initial refresh", () => {
    const { factory, sockets } = makeFactory();
    const conn = new ServerRealtimeConnection(jfConfig, callbacks(), factory);
    conn.start();
    expect(statuses).toContainEqual(["s2", "connecting"]);

    sockets[0].fireOpen();
    expect(sockets[0].sent).toContain(JSON.stringify({ MessageType: "SessionsStart", Data: "0,1500" }));
    expect(conn.getStatus()).toBe("connected");
    expect(events.some((e) => e.kind === "session-changed")).toBe(true);
    expect(events.some((e) => e.kind === "server-status" && e.status === "connected")).toBe(true);
  });

  it("sends no subscription for Plex", () => {
    const { factory, sockets } = makeFactory();
    new ServerRealtimeConnection(plexConfig, callbacks(), factory).start();
    sockets[0].fireOpen();
    expect(sockets[0].sent).toEqual([]);
  });

  it("normalizes inbound messages to canonical events", () => {
    const { factory, sockets } = makeFactory();
    new ServerRealtimeConnection(plexConfig, callbacks(), factory).start();
    sockets[0].fireOpen();
    events.length = 0;
    sockets[0].fireMessage({
      NotificationContainer: { type: "playing", PlaySessionStateNotification: [{ state: "playing" }] },
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "session-changed", serverId: "s1" }));
  });

  it("responds to Jellyfin ForceKeepAlive without emitting an event", () => {
    const { factory, sockets } = makeFactory();
    new ServerRealtimeConnection(jfConfig, callbacks(), factory).start();
    sockets[0].fireOpen();
    sockets[0].sent.length = 0;
    events.length = 0;
    sockets[0].fireMessage({ MessageType: "ForceKeepAlive", Data: 60 });
    expect(sockets[0].sent).toEqual([JSON.stringify({ MessageType: "KeepAlive" })]);
    expect(events).toEqual([]);
  });

  it("drops redundant Jellyfin Sessions frames but emits on a real change", () => {
    const { factory, sockets } = makeFactory();
    new ServerRealtimeConnection(jfConfig, callbacks(), factory).start();
    sockets[0].fireOpen();
    events.length = 0;

    const frame = (paused: boolean, pos: number) => ({
      MessageType: "Sessions",
      Data: [{ Id: "s", NowPlayingItem: { Id: "i" }, PlayState: { IsPaused: paused, PositionTicks: pos } }],
    });

    // First frame → one session-changed.
    sockets[0].fireMessage(frame(false, 1000));
    expect(events.filter((e) => e.kind === "session-changed")).toHaveLength(1);

    // Same meaningful state, only position advanced → dropped (no new event).
    sockets[0].fireMessage(frame(false, 2000));
    sockets[0].fireMessage(frame(false, 3000));
    expect(events.filter((e) => e.kind === "session-changed")).toHaveLength(1);

    // Pause state changed → a new event.
    sockets[0].fireMessage(frame(true, 3000));
    expect(events.filter((e) => e.kind === "session-changed")).toHaveLength(2);
  });

  it("ignores non-JSON frames", () => {
    const { factory, sockets } = makeFactory();
    new ServerRealtimeConnection(plexConfig, callbacks(), factory).start();
    sockets[0].fireOpen();
    events.length = 0;
    sockets[0].fireMessage("<<not json>>");
    expect(events).toEqual([]);
  });

  it("sends periodic keepalive (Jellyfin) and ping (Plex)", () => {
    const jf = makeFactory();
    new ServerRealtimeConnection(jfConfig, callbacks(), jf.factory).start();
    jf.sockets[0].fireOpen();
    jf.sockets[0].sent.length = 0;
    vi.advanceTimersByTime(30_000);
    expect(jf.sockets[0].sent).toContain(JSON.stringify({ MessageType: "KeepAlive" }));

    const plex = makeFactory();
    new ServerRealtimeConnection(plexConfig, callbacks(), plex.factory).start();
    plex.sockets[0].fireOpen();
    vi.advanceTimersByTime(30_000);
    expect(plex.sockets[0].pings).toBeGreaterThanOrEqual(1);
  });

  it("reconnects with exponential backoff after a close", () => {
    const { factory, sockets } = makeFactory();
    const conn = new ServerRealtimeConnection(plexConfig, callbacks(), factory);
    conn.start();
    sockets[0].fireOpen();
    sockets[0].fireClose();

    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // 1000ms → first reconnect
    expect(sockets).toHaveLength(2);

    sockets[1].fireClose(); // never opened → next backoff is 2000ms
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it("resets backoff after a successful open", () => {
    const { factory, sockets } = makeFactory();
    const conn = new ServerRealtimeConnection(plexConfig, callbacks(), factory);
    conn.start();
    sockets[0].fireClose(); // fail before open → backoff 1000
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].fireOpen(); // success resets the attempt counter
    sockets[1].fireClose(); // backoff should be 1000 again, not 2000
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
  });

  it("stop() closes the socket and prevents any reconnect", () => {
    const { factory, sockets } = makeFactory();
    const conn = new ServerRealtimeConnection(plexConfig, callbacks(), factory);
    conn.start();
    sockets[0].fireOpen();
    conn.stop();
    expect(sockets[0].closed).toBe(true);
    // A late close event must not trigger a reconnect.
    sockets[0].fireClose();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(conn.getStatus()).toBe("disconnected");
  });
});
