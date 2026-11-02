import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  appSettings: { findFirst: vi.fn() },
  mediaServer: { findMany: vi.fn() },
  enqueueJob: vi.fn(),
  runEnforcerTick: vi.fn(),
  appEmit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { appSettings: h.appSettings, mediaServer: h.mediaServer } }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: h.enqueueJob }));
vi.mock("@/lib/maintenance/enforcer", () => ({ runEnforcerTick: h.runEnforcerTick }));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: h.appEmit } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { RealtimeManager } from "@/lib/media-server/realtime/manager";
import { _resetSelfWritesForTesting } from "@/lib/media-server/realtime/self-writes";
import type { RealtimeSocket, SocketFactory } from "@/lib/media-server/realtime/socket";
import type { RealtimeEvent, RealtimeServerConfig } from "@/lib/media-server/realtime/types";
import { MAIN_QUEUE, TASK_SYNC_INCREMENTAL, TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY } from "@/lib/jobs/constants";

// Edge paths of the manager the main suite does not reach: failing settings /
// server reads, a reconcile requested mid-reconcile, a failed enforcer tick,
// events for a server that has since gone, and enqueues that report failure.

class FakeSocket implements RealtimeSocket {
  closed = false;
  msgCb: ((d: string) => void) | null = null;
  send() {}
  close() {
    this.closed = true;
  }
  ping() {}
  onOpen() {}
  onMessage(cb: (d: string) => void) {
    this.msgCb = cb;
  }
  onClose() {}
  onError() {}
  fire(obj: unknown) {
    this.msgCb?.(JSON.stringify(obj));
  }
}

function factory() {
  const sockets: FakeSocket[] = [];
  const f: SocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  return { f, sockets };
}

const jf: RealtimeServerConfig = {
  id: "j1",
  name: "JF",
  type: "JELLYFIN",
  url: "http://jf",
  accessToken: "t",
  tlsSkipVerify: false,
  userId: "user-1",
};

/** The manager's private event entry point, for events no socket can produce in order. */
function handle(mgr: RealtimeManager, event: Partial<RealtimeEvent> & Pick<RealtimeEvent, "kind" | "serverId">) {
  (mgr as unknown as { handleEvent(e: RealtimeEvent): void }).handleEvent({
    serverType: "JELLYFIN",
    at: Date.now(),
    ...event,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  _resetSelfWritesForTesting();
  h.enqueueJob.mockResolvedValue(true);
  h.runEnforcerTick.mockResolvedValue(undefined);
  h.appSettings.findFirst.mockResolvedValue({ realtimeSync: true });
  h.mediaServer.findMany.mockResolvedValue([jf]);
});
afterEach(() => vi.useRealTimers());

describe("RealtimeManager — settings and reconcile failures", () => {
  it("treats realtime as ON when no settings row exists yet", async () => {
    h.appSettings.findFirst.mockResolvedValue(null);
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    expect(sockets).toHaveLength(1);
    mgr.stopAll();
  });

  it("treats an unreadable setting as disabled and closes live connections", async () => {
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    expect(sockets).toHaveLength(1);

    h.appSettings.findFirst.mockRejectedValue(new Error("db down"));
    await mgr.reconcile();
    expect(sockets[0].closed).toBe(true);
    expect(mgr.getStatuses()).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      "Realtime",
      "Could not read realtime setting; treating as disabled",
      { error: "Error: db down" },
    );
  });

  it("logs and keeps existing connections when the server list cannot be read", async () => {
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();

    h.mediaServer.findMany.mockRejectedValue(new Error("boom"));
    await expect(mgr.reconcile()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("Realtime", "Reconcile failed", { error: "Error: boom" });
    expect(sockets[0].closed).toBe(false);
    expect(mgr.getStatuses()).toHaveLength(1);
    mgr.stopAll();
  });

  it("runs one more pass with fresh state for a reconcile requested mid-run", async () => {
    let release!: (v: RealtimeServerConfig[]) => void;
    h.mediaServer.findMany.mockImplementationOnce(() => new Promise((r) => (release = r)));
    h.mediaServer.findMany.mockResolvedValue([jf, { ...jf, id: "j2", name: "JF2", url: "http://jf2" }]);
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);

    const first = mgr.reconcile();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));
    // Coalesced: returns at once rather than running a second loop.
    await mgr.reconcile();
    release([jf]);
    await first;

    expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2);
    expect(mgr.getStatuses().map((s) => s.serverId).sort()).toEqual(["j1", "j2"]);
    expect(sockets).toHaveLength(2);
    mgr.stopAll();
  });
});

describe("RealtimeManager — side-effect edges", () => {
  it("logs a failed enforcer tick instead of throwing", async () => {
    h.runEnforcerTick.mockRejectedValue(new Error("enforcer broke"));
    const { f } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    handle(mgr, { kind: "session-changed", serverId: "j1" });
    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith("Realtime", "Enforcer tick failed", {
        error: "Error: enforcer broke",
      }),
    );
    mgr.stopAll();
  });

  it("ignores a server-status for a server it no longer manages, and a connecting state", async () => {
    const { f } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    handle(mgr, { kind: "server-status", serverId: "gone", status: "disconnected" });
    handle(mgr, { kind: "server-status", serverId: "j1", status: "connecting" });
    expect(h.appEmit).not.toHaveBeenCalled();

    handle(mgr, { kind: "server-status", serverId: "j1", status: "disconnected" });
    handle(mgr, { kind: "server-status", serverId: "j1", status: "connected" });
    expect(h.appEmit.mock.calls.map((c) => c[0].meta.connected)).toEqual([false, true]);
    mgr.stopAll();
  });

  it("bridges no session change for a server it does not manage", async () => {
    const { f } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    // Neither the leading-edge run nor the trailing one has a connection to
    // name the owner from, so neither reaches the browser.
    handle(mgr, { kind: "session-changed", serverId: "orphan" });
    handle(mgr, { kind: "session-changed", serverId: "orphan" });
    vi.advanceTimersByTime(5_000);
    expect(h.appEmit).not.toHaveBeenCalled();
    mgr.stopAll();
  });

  it("treats a library-changed event without detail as contributing nothing", async () => {
    const { f } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    handle(mgr, { kind: "library-changed", serverId: "j1" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.enqueueJob).not.toHaveBeenCalled();
    mgr.stopAll();
  });

  it("labels a server that is not connected by its id, and keeps removed-only changes", async () => {
    const { f } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    handle(mgr, { kind: "library-changed", serverId: "other", detail: { removedIds: ["r1"] } });
    vi.advanceTimersByTime(6_000);
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        "Realtime",
        "Enqueued incremental sync for server other (0 changed, 1 removed)",
      ),
    );
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "other", changedIds: [], removedIds: ["r1"] },
      { queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
    mgr.stopAll();
  });

  it("logs nothing when an enqueue reports it did not queue", async () => {
    h.enqueueJob.mockResolvedValue(false);
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();

    sockets[0].fire({ MessageType: "LibraryChanged", Data: { ItemsAdded: ["a"] } });
    sockets[0].fire({ MessageType: "LibraryChanged", Data: { ItemsAdded: Array.from({ length: 150 }, (_, i) => `b${i}`) } });
    sockets[0].fire({ MessageType: "UserDataChanged" });
    vi.advanceTimersByTime(6 * 60_000);
    expect(h.enqueueJob.mock.calls.map((c) => c[0]).sort()).toEqual(
      [TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY].sort(),
    );
    // The manager's `.then` was attached to each of these promises first, so
    // once they have all settled here its handlers have run.
    await Promise.all(h.enqueueJob.mock.results.map((r) => r.value));
    expect(logger.info).not.toHaveBeenCalledWith("Realtime", expect.stringContaining("Enqueued"));
    mgr.stopAll();
  });

  it("closes a server's connection when only its TLS setting changes", async () => {
    const { f, sockets } = factory();
    const mgr = new RealtimeManager(f);
    await mgr.reconcile();
    h.mediaServer.findMany.mockResolvedValue([{ ...jf, tlsSkipVerify: true }]);
    await mgr.reconcile();
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    mgr.stopAll();
  });
});
