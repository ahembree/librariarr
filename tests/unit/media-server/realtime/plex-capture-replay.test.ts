import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression tests replaying REAL Plex WebSocket frames, captured from a live
 * server, through the whole realtime path (normalizer → manager accumulator →
 * debounce → enqueue).
 *
 * They exist because the failure they pin down was invisible to synthetic
 * fixtures. On the real wire a single library add is not one tidy event: adding
 * one movie produced dozens of `timeline` frames and thousands of `activity`
 * frames, and the
 * three id-less `library.*` activities among them latched a `forceFull` flag
 * that discarded every ratingKey collected beside them. One added movie became
 * two whole-server syncs. Plex's periodic
 * metadata refresh (`library.refresh.items`) did the same thing on its own,
 * producing full syncs when nothing had changed at all.
 *
 * Fixtures in `fixtures/` are the captured frames, trimmed to the fields the
 * normalizer reads.
 */

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
import { TASK_SYNC_SERVER, TASK_SYNC_INCREMENTAL } from "@/lib/jobs/constants";
import type { RealtimeSocket, SocketFactory } from "@/lib/media-server/realtime/socket";
import addFrames from "./fixtures/plex-add.json";
import delMovieFrames from "./fixtures/plex-del-movie.json";
import delEpisodeFrames from "./fixtures/plex-del-ep.json";
import metadataUpdateFrames from "./fixtures/plex-metadata-update.json";

class FakeSocket implements RealtimeSocket {
  private msgCb: ((d: string) => void) | null = null;
  send() {}
  close() {}
  ping() {}
  onOpen() {}
  onMessage(cb: (d: string) => void) {
    this.msgCb = cb;
  }
  onClose() {}
  onError() {}
  fireMessage(obj: unknown) {
    this.msgCb?.(JSON.stringify(obj));
  }
}

const plexServer = {
  id: "p1", name: "Test Plex", type: "PLEX" as const,
  url: "http://plex", accessToken: "t", tlsSkipVerify: false,
};

async function replay(frames: unknown[]) {
  h.appSettings.findFirst.mockResolvedValue({ realtimeSync: true });
  h.mediaServer.findMany.mockResolvedValue([plexServer]);
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const mgr = new RealtimeManager(factory);
  await mgr.reconcile();
  for (const frame of frames) sockets[0].fireMessage({ NotificationContainer: frame });
  // Past the 5s quiet window so the debouncer flushes.
  vi.advanceTimersByTime(30_000);
  return {
    incremental: h.enqueueJob.mock.calls.filter((c) => c[0] === TASK_SYNC_INCREMENTAL),
    full: h.enqueueJob.mock.calls.filter((c) => c[0] === TASK_SYNC_SERVER),
  };
}

describe("Plex realtime — replay of captured frames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    h.enqueueJob.mockResolvedValue(true);
    h.runEnforcerTick.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("adding one movie syncs exactly that movie, not the whole server", async () => {
    // 34 timeline frames naming 28 distinct ratingKeys (the movie plus 27
    // extras/trailers belonging to no library section), and 3 ended `library.*`
    // activities. Previously: one whole-server sync. Now: one item.
    const { incremental, full } = await replay(addFrames);
    expect(full).toHaveLength(0);
    expect(incremental).toHaveLength(1);
    expect(incremental[0][1]).toEqual({
      serverId: "p1",
      changedIds: ["169827"],
      removedIds: [],
    });
  });

  it("deleting a movie syncs exactly that movie", async () => {
    // The deletion burst carries the movie (sectionID 1) alongside the deletion
    // of all 27 of its sectionless extras.
    const { incremental, full } = await replay(delMovieFrames);
    expect(full).toHaveLength(0);
    expect(incremental).toHaveLength(1);
    expect(incremental[0][1]).toEqual({
      serverId: "p1",
      changedIds: ["169827"],
      removedIds: [],
    });
  });

  it("deleting an episode syncs exactly that episode", async () => {
    // A deleted episode arrives sectionID=2 type=4 state=9 metadataState=deleted
    // — a valid section, which is why dropping sectionless entries is safe.
    const { incremental, full } = await replay(delEpisodeFrames);
    expect(full).toHaveLength(0);
    expect(incremental).toHaveLength(1);
    expect(incremental[0][1]).toEqual({
      serverId: "p1",
      changedIds: ["138453"],
      removedIds: [],
    });
  });

  it("an episode metadata refresh syncs that episode, not the server", async () => {
    // A real window in which Plex refreshed one episode's metadata: three
    // timeline frames for ratingKey 138167 plus an ended
    // `library.update.item.metadata` activity carrying Context null. That
    // id-less activity is precisely what used to latch forceFull and discard
    // the ratingKey sitting beside it.
    const { incremental, full } = await replay(metadataUpdateFrames);
    expect(full).toHaveLength(0);
    expect(incremental).toHaveLength(1);
    expect(incremental[0][1]).toEqual({
      serverId: "p1",
      changedIds: ["138167"],
      removedIds: [],
    });
  });

  it("an idle metadata-refresh cycle enqueues nothing", async () => {
    // `library.refresh.items` ends with Context null and zero timeline entries:
    // nothing changed. Three of these fired in 20s on the live server, each
    // costing a full server sync.
    const { incremental, full } = await replay([
      { type: "activity", ActivityNotification: [{ event: "ended", Activity: { type: "library.refresh.items" } }] },
      { type: "activity", ActivityNotification: [{ event: "ended", Activity: { type: "library.refresh.items" } }] },
      { type: "activity", ActivityNotification: [{ event: "ended", Activity: { type: "library.refresh.items" } }] },
    ]);
    expect(full).toHaveLength(0);
    expect(incremental).toHaveLength(0);
  });

  it("a genuinely bulk change still falls back to a full sync", async () => {
    // The >100 threshold is untouched: listing the libraries beats fetching
    // each item individually.
    const many = Array.from({ length: 150 }, (_, i) => ({
      sectionID: "1", itemID: String(1000 + i), type: 1, state: 5,
    }));
    const { incremental, full } = await replay([{ type: "timeline", TimelineEntry: many }]);
    expect(incremental).toHaveLength(0);
    expect(full).toHaveLength(1);
    expect(full[0][1]).toEqual({ serverId: "p1" });
  });
});
