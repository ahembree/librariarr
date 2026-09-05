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
import {
  markSelfWrites,
  SELF_WRITE_TTL_MS,
  _resetSelfWritesForTesting,
} from "@/lib/media-server/realtime/self-writes";
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

const jfServer: ServerRow = { id: "j1", name: "JF", type: "JELLYFIN", url: "http://jf", accessToken: "t", tlsSkipVerify: false, userId: "user-1" };
const plexServer: ServerRow = { id: "p1", name: "Plex", type: "PLEX", url: "http://plex", accessToken: "t", tlsSkipVerify: false, userId: "user-1" };

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
    _resetSelfWritesForTesting();
    h.enqueueJob.mockResolvedValue(true);
    h.runEnforcerTick.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("opens one connection per enabled server, including multiple of the same type", async () => {
    const { mgr, sockets } = await setup([
      { id: "p1", name: "Plex A", type: "PLEX", url: "http://a", accessToken: "t", tlsSkipVerify: false, userId: "user-1" },
      { id: "p2", name: "Plex B", type: "PLEX", url: "http://b", accessToken: "t", tlsSkipVerify: false, userId: "user-1" },
      { id: "j1", name: "JF", type: "JELLYFIN", url: "http://j", accessToken: "t", tlsSkipVerify: false, userId: "user-1" },
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

  it("enqueues nothing when a change carries no item ids", async () => {
    const { sockets } = await setup([jfServer]);
    // Empty LibraryChanged (no specific items). "Something changed but we don't
    // know what" is not actionable — treating it as a full reconcile is what
    // made a single library event cost a whole-server sync. The scheduled sync
    // remains the reconciliation backstop.
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: {} });
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).not.toHaveBeenCalled();
  });

  it("does not let an id-less change discard ids accumulated in the same window", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: { ItemsAdded: ["x"] } });
    // An id-less event landing in the same debounce window used to latch
    // `forceFull` and throw away every ratingKey collected beside it.
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: {} });
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "j1", changedIds: ["x"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
    expect(h.enqueueJob.mock.calls.some((c) => c[0] === TASK_SYNC_SERVER)).toBe(false);
  });

  it("an id-less event does not reset the quiet window of accumulated ids", async () => {
    const { sockets } = await setup([jfServer]);
    // A Jellyfin scan can emit LibraryChanged frames whose Items* arrays are all
    // empty (e.g. only FoldersAddedTo). Those contribute nothing, so if they
    // re-armed the 5s debounce the real id beside them would be held until the
    // 5-minute ceiling instead of syncing "within a few seconds".
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: { ItemsAdded: ["a"] } });
    vi.advanceTimersByTime(2_000);             // t=2s
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: {} });
    vi.advanceTimersByTime(2_000);             // t=4s
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: {} });
    expect(h.enqueueJob).not.toHaveBeenCalled();

    // t=5.5s — past the window measured from the FIRST (id-carrying) event.
    // If an id-less event re-armed the debouncer this would still be pending.
    vi.advanceTimersByTime(1_500);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "j1", changedIds: ["a"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("falls back to a full sync when the change set exceeds the threshold", async () => {
    const { sockets } = await setup([jfServer]);
    const many = Array.from({ length: 150 }, (_, i) => `m${i}`);
    sockets[0].fireMessage({ MessageType: "LibraryChanged", Data: { ItemsAdded: many } });
    vi.advanceTimersByTime(30_000);
    // The payload names the trigger, so the full sync it starts logs WHY it ran.
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: "j1", trigger: expect.stringContaining("150 changed item(s) exceeds the 100-item") },
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
  // ── realtimeBus -> app eventBus bridge ────────────────────────────
  // realtimeBus is server-side only; these are the only events that reach the
  // browser, and they are what let the sidebar and shell stop polling.

  it("bridges session-changed to the app bus so the browser can drop its 30s poll", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen();

    const sessionEvents = h.appEmit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "session-changed");
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toEqual({
      type: "session-changed",
      userId: "user-1",
      meta: { serverId: "j1" },
    });
  });

  it("carries no session data on the bridged event", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen();

    const event = h.appEmit.mock.calls.map((c) => c[0]).find((e) => e.type === "session-changed");
    expect(Object.keys(event.meta)).toEqual(["serverId"]);
  });

  it("throttles bridged session changes, so a busy server cannot flood open tabs", async () => {
    // Each bridged event costs every listening tab one /api/tools/sessions
    // query, and that route fans out to every media server.
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen();
    sockets[0].fireMessage({ MessageType: "PlaybackProgress" });
    sockets[0].fireMessage({ MessageType: "PlaybackProgress" });

    const count = () =>
      h.appEmit.mock.calls.map((c) => c[0]).filter((e) => e.type === "session-changed").length;
    expect(count()).toBe(1);

    vi.advanceTimersByTime(2000);
    expect(count()).toBe(2); // single trailing fire
  });

  it("bridges a server-status transition to the app bus", async () => {
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen();

    const statusEvents = h.appEmit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "server-status");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].meta).toMatchObject({
      serverId: "j1",
      serverName: "JF",
      connected: true,
    });
  });

  it("does not re-emit server-status for a repeated identical state", async () => {
    // A server that is simply down produces a status event per failed reconnect
    // attempt; the browser must not get one event per attempt.
    const { sockets } = await setup([jfServer]);
    sockets[0].fireOpen();
    sockets[0].fireOpen();
    sockets[0].fireOpen();

    const statusEvents = h.appEmit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "server-status");
    expect(statusEvents).toHaveLength(1);
  });

  // ── Self-write suppression ──────────────────────────────────────────
  // Plex reports librariarr's own collection writes back as timeline entries
  // for the collection and every member it tagged. Those must never become a
  // sync: a manual detection run that synced a 150-item collection used to
  // enqueue an off-schedule whole-server sync.

  const plexTimeline = (entries: Array<Record<string, unknown>>) => ({
    NotificationContainer: { type: "timeline", TimelineEntry: entries },
  });

  it("ignores library changes that echo librariarr's own collection writes", async () => {
    const { sockets } = await setup([plexServer]);
    markSelfWrites("p1", ["col-1", "m1", "m2"]);
    sockets[0].fireMessage(plexTimeline([
      { sectionID: "1", itemID: "col-1", type: 18, state: 5 },
      { sectionID: "1", itemID: "m1", type: 1, state: 5 },
      { sectionID: "1", itemID: "m2", type: 1, state: 5 },
      // A real change arriving in the same window is still applied.
      { sectionID: "1", itemID: "m3", type: 1, state: 5 },
    ]));
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledTimes(1);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "p1", changedIds: ["m3"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("a collection write larger than the incremental limit does not escalate to a full sync", async () => {
    // The user-visible bug: detection → collection sync → 150 tagged members →
    // "150 changed items exceeds 100" → whole-server sync, off schedule.
    const { sockets } = await setup([plexServer]);
    const members = Array.from({ length: 150 }, (_, i) => `m${i}`);
    markSelfWrites("p1", ["col-1", ...members]);
    sockets[0].fireMessage(plexTimeline([
      { sectionID: "1", itemID: "col-1", type: 18, state: 5 },
      ...members.map((id) => ({ sectionID: "1", itemID: id, type: 1, state: 5 })),
    ]));
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).not.toHaveBeenCalled();
  });

  it("logs one summary line for a burst of suppressed echoes, not one per frame", async () => {
    const { sockets } = await setup([plexServer]);
    markSelfWrites("p1", ["m1", "m2", "m3"]);
    // Plex sends one frame per tagged member.
    for (const id of ["m1", "m2", "m3"]) {
      sockets[0].fireMessage(plexTimeline([{ sectionID: "1", itemID: id, type: 1, state: 5 }]));
    }
    vi.advanceTimersByTime(30_000);
    const lines = vi
      .mocked(logger.info)
      .mock.calls.map((c) => String(c[1]))
      .filter((m) => m.includes("echo"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ignored 3 library change(s)");
    expect(lines[0]).toContain('"Plex"');
  });

  it("never suppresses a deletion, even for a marked item", async () => {
    // Nothing librariarr writes deletes media, and a row left alive for media
    // that is gone is the worse failure — so a deletion frame always goes through.
    const { sockets } = await setup([plexServer]);
    markSelfWrites("p1", ["m1"]);
    sockets[0].fireMessage(plexTimeline([
      { sectionID: "1", itemID: "m1", type: 1, state: 9, metadataState: "deleted" },
    ]));
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "p1", changedIds: ["m1"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("a mark is scoped to its server", async () => {
    // Rating keys are per-server rowids: the same key on another server is a
    // different item, and its change is real.
    const { sockets } = await setup([
      plexServer,
      { id: "p2", name: "Plex B", type: "PLEX", url: "http://b", accessToken: "t", tlsSkipVerify: false, userId: "user-1" },
    ]);
    markSelfWrites("p1", ["m1"]);
    sockets[1].fireMessage(plexTimeline([{ sectionID: "1", itemID: "m1", type: 1, state: 5 }]));
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "p2", changedIds: ["m1"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("a suppressed echo does not re-arm the quiet window of real accumulated ids", async () => {
    // Same rule as an id-less event: an echo contributes nothing, so it must
    // not hold a real change hostage for as long as a collection sync writes.
    const { sockets } = await setup([plexServer]);
    markSelfWrites("p1", ["m1"]);
    sockets[0].fireMessage(plexTimeline([{ sectionID: "1", itemID: "real", type: 1, state: 5 }]));
    vi.advanceTimersByTime(4_000);
    sockets[0].fireMessage(plexTimeline([{ sectionID: "1", itemID: "m1", type: 1, state: 5 }]));
    vi.advanceTimersByTime(1_500); // 5.5s after the real change
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "p1", changedIds: ["real"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });

  it("a mark expires, so a later real change to the same item is applied", async () => {
    const { sockets } = await setup([plexServer]);
    markSelfWrites("p1", ["m1"]);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS + 1);
    sockets[0].fireMessage(plexTimeline([{ sectionID: "1", itemID: "m1", type: 1, state: 5 }]));
    vi.advanceTimersByTime(30_000);
    expect(h.enqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_INCREMENTAL,
      { serverId: "p1", changedIds: ["m1"], removedIds: [] },
      expect.objectContaining({ queueName: MAIN_QUEUE }),
    );
  });
});
