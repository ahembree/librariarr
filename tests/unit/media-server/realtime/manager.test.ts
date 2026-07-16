import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  appSettings: { findFirst: vi.fn() },
  mediaServer: { findMany: vi.fn() },
  enqueueJob: vi.fn(),
  runEnforcerTick: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { appSettings: h.appSettings, mediaServer: h.mediaServer } }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: h.enqueueJob }));
vi.mock("@/lib/maintenance/enforcer", () => ({ runEnforcerTick: h.runEnforcerTick }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RealtimeManager } from "@/lib/media-server/realtime/manager";
import { MAIN_QUEUE, TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY, TASK_SYNC_INCREMENTAL } from "@/lib/jobs/constants";
import type { RealtimeSocket, SocketFactory } from "@/lib/media-server/realtime/socket";
import type { RealtimeServerConfig } from "@/lib/media-server/realtime/types";

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
  fireOpen() {
    this.openCb?.();
  }
  fireMessage(obj: unknown) {
    this.msgCb?.(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  fireClose(code = 1006) {
    this.closeCb?.(code, "gone");
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

type ServerRow = RealtimeServerConfig;

const jfServer: ServerRow = { id: "j1", name: "JF", type: "JELLYFIN", url: "http://jf", accessToken: "t", tlsSkipVerify: false };
const plexServer: ServerRow = { id: "p1", name: "Plex", type: "PLEX", url: "http://plex", accessToken: "t", tlsSkipVerify: false };

async function setup(servers: ServerRow[], enabled = true) {
  h.appSettings.findFirst.mockResolvedValue({ realtimeSync: enabled });
  h.mediaServer.findMany.mockResolvedValue(servers);
  const { factory, sockets } = makeFactory();
  const mgr = new RealtimeManager(factory);
  await mgr.reconcile();
  return { mgr, sockets };
}

describe("RealtimeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    h.enqueueJob.mockResolvedValue(true);
    h.runEnforcerTick.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("opens one connection per enabled server, including multiple of the same type", async () => {
    const { mgr, sockets } = await setup([
      { id: "p1", name: "Plex A", type: "PLEX", url: "http://a", accessToken: "t", tlsSkipVerify: false },
      { id: "p2", name: "Plex B", type: "PLEX", url: "http://b", accessToken: "t", tlsSkipVerify: false },
      { id: "j1", name: "JF", type: "JELLYFIN", url: "http://j", accessToken: "t", tlsSkipVerify: false },
    ]);
    expect(sockets).toHaveLength(3);
    expect(mgr.getStatuses().map((s) => s.serverId).sort()).toEqual(["j1", "p1", "p2"]);
  });

  it("does not reopen existing connections on a repeat reconcile", async () => {
    const { mgr, sockets } = await setup([jfServer]);
    await mgr.reconcile();
    expect(sockets).toHaveLength(1);
  });

  it("closes a connection when its server is removed", async () => {
    const { mgr, sockets } = await setup([jfServer, plexServer]);
    expect(sockets).toHaveLength(2);
    h.mediaServer.findMany.mockResolvedValue([jfServer]);
    await mgr.reconcile();
    expect(sockets[1].closed).toBe(true); // plex socket
    expect(mgr.getStatuses().map((s) => s.serverId)).toEqual(["j1"]);
  });

  it("refreshes the reported server name on a rename without reconnecting", async () => {
    const { mgr, sockets } = await setup([jfServer]);
    expect(mgr.getStatuses()[0].name).toBe("JF");
    // Only the name changed → signature unchanged → connection kept, name refreshed.
    h.mediaServer.findMany.mockResolvedValue([{ ...jfServer, name: "Renamed JF" }]);
    await mgr.reconcile();
    expect(sockets).toHaveLength(1);
    expect(mgr.getStatuses()[0].name).toBe("Renamed JF");
  });

  it("recycles a connection when the server config changes (new token)", async () => {
    const { mgr, sockets } = await setup([jfServer]);
    h.mediaServer.findMany.mockResolvedValue([{ ...jfServer, accessToken: "new-token" }]);
    await mgr.reconcile();
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it("closes all connections when realtime is disabled", async () => {
    const { mgr, sockets } = await setup([jfServer, plexServer]);
    h.appSettings.findFirst.mockResolvedValue({ realtimeSync: false });
    await mgr.reconcile();
    expect(mgr.getStatuses()).toHaveLength(0);
    expect(sockets.every((s) => s.closed)).toBe(true);
  });

  it("runs the enforcer immediately on a session change (leading edge)", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen(); // emits an initial session-changed refresh
    expect(h.runEnforcerTick).toHaveBeenCalledOnce();
  });

  it("floors repeated session changes to one enforcer run per interval", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen(); // leading-edge run
    expect(h.runEnforcerTick).toHaveBeenCalledTimes(1);
    // Rapid follow-ups within the throttle interval are coalesced.
    sockets[0].fireMessage({ MessageType: "PlaybackProgress" });
    sockets[0].fireMessage({ MessageType: "PlaybackProgress" });
    expect(h.runEnforcerTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(h.runEnforcerTick).toHaveBeenCalledTimes(2); // single trailing run
  });

  it("enqueues a debounced incremental sync with the changed/removed ids", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireMessage({
      MessageType: "LibraryChanged",
      Data: { ItemsAdded: ["x"], ItemsUpdated: ["y"], ItemsRemoved: ["z"] },
    });
    expect(h.enqueueJob).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "j1", changedIds: ["x", "y"], removedIds: ["z"] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("falls back to a full sync when a change carries no item ids", async () => {
    const { sockets } = await setup([jfServer]);
    // Empty LibraryChanged (no specific items) → can't apply incrementally.
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: {} });
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: "j1" },
      expect.objectContaining({ jobKey: "sync:j1", queueName: MAIN_QUEUE }),
    );
    expect(h.enqueueJob.mock.calls.some((c) => c[0] === TASK_SYNC_INCREMENTAL)).toBe(false);
  });

  it("falls back to a full sync when the change set exceeds the threshold", async () => {
    const { sockets } = await setup([jfServer]);
    const many = Array.from({ length: 150 }, (_, i) => `m${i}`);
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: { ItemsAdded: many } });
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: "j1" },
      expect.objectContaining({ jobKey: "sync:j1" }),
    );
    expect(h.enqueueJob.mock.calls.some((c) => c[0] === TASK_SYNC_INCREMENTAL)).toBe(false);
  });

  it("enqueues a debounced watch-history refresh on a watch change", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireMessage({ MessageType: "UserDataChanged" });
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_WATCH_HISTORY,
      { serverId: "j1" },
      expect.objectContaining({ jobKey: "watch-history:j1", queueName: MAIN_QUEUE }),
    );
  });

  it("coalesces a burst of library changes into a single incremental sync with all ids", async () => {
    const { sockets } = await setup([jfServer]);
    for (let i = 0; i < 10; i++) {
      sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: { ItemsAdded: [`x${i}`] } });
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(30_000);
    const syncCalls = h.enqueueJob.mock.calls.filter((c) => c[0] === TASK_SYNC_INCREMENTAL);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0][1]).toEqual({
      serverId: "j1",
      changedIds: Array.from({ length: 10 }, (_, i) => `x${i}`),
      removedIds: [],
    });
  });

  it("stopAll closes every connection", async () => {
    const { mgr, sockets } = await setup([jfServer, plexServer]);
    mgr.stopAll();
    expect(sockets.every((s) => s.closed)).toBe(true);
    expect(mgr.getStatuses()).toHaveLength(0);
  });
});
