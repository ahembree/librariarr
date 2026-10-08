/**
 * The History page's Refresh (`POST /api/media/history/sync`) and the native
 * sync engine against a real database; only the media-server client is faked
 * (`history-sync.test.ts` covers the route's stream with the engine stubbed).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    getDetailedWatchHistory: vi.fn(),
    supportsHistorySince: false as boolean,
  },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => mockClient),
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: vi.fn(async () => true),
  isJobRetrying: vi.fn(async () => false),
}));

import { POST } from "@/app/api/media/history/sync/route";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { invalidateWatchHistoryEvidence } from "@/lib/media/watch-evidence";

type SyncResult = { success: boolean; counts: Record<string, number>; cancelled: boolean };

const prisma = getTestPrisma();

const play = (ratingKey: string, username: string, watchedAt: string, librarySectionKey?: string) => ({
  ratingKey,
  username,
  watchedAt,
  deviceName: null,
  platform: null,
  ...(librarySectionKey ? { librarySectionKey } : {}),
});

describe("POST /api/media/history/sync over the real native sync", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockClient.getDetailedWatchHistory.mockReset();
    mockClient.supportsHistorySince = false;
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** A server whose one library holds item 100. */
  async function serverWithItem(server: Parameters<typeof createTestServer>[1] = {}) {
    const srv = await createTestServer(userId, server);
    const library = await createTestLibrary(srv.id);
    const item = await createTestMediaItem(library.id, { ratingKey: "100" });
    return { server: srv, item };
  }
  const markerOf = async (serverId: string) =>
    (await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).watchHistorySyncedAt;

  it("reports a server whose fetch failed as failed, and leaves its history untouched", async () => {
    const established = new Date("2025-01-01T00:00:00Z");
    const { server, item } = await serverWithItem({ watchHistorySyncedAt: established });
    await prisma.watchHistory.create({
      data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date("2024-12-01T00:00:00Z") },
    });
    mockClient.getDetailedWatchHistory.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { result } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
    );

    // Not a clean zero.
    expect(result.counts).toEqual({ [server.id]: -1 });
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(1);
    expect(await markerOf(server.id)).toEqual(established);
  });

  it("reports what it stored and establishes the history on success", async () => {
    const { server } = await serverWithItem({ watchHistorySyncedAt: null });
    mockClient.getDetailedWatchHistory.mockResolvedValue([play("100", "alice", "2025-02-01T00:00:00.000Z")]);

    const { result } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
    );

    expect(result.counts).toEqual({ [server.id]: 1 });
    expect(await markerOf(server.id)).toBeInstanceOf(Date);
  });

  it.each([
    // The marker was already null (a first sync): only the withdrawal counter can tell.
    { withdrawal: "counted while the marker was null", marker: null, withdraw: (id: string) => invalidateWatchHistoryEvidence([id]) },
    // Caught by the compare-and-set itself, whoever wrote the null.
    {
      withdrawal: "a direct write nulling an established marker",
      marker: new Date("2025-01-01T00:00:00Z"),
      withdraw: (id: string) => prisma.mediaServer.update({ where: { id }, data: { watchHistorySyncedAt: null } }),
    },
  ])("does not re-establish a history withdrawn mid-fetch ($withdrawal)", async ({ marker, withdraw }) => {
    const { server } = await serverWithItem({ watchHistorySyncedAt: marker });
    mockClient.getDetailedWatchHistory.mockImplementation(async () => {
      await withdraw(server.id);
      return [play("100", "alice", "2025-02-01T00:00:00.000Z")];
    });

    await syncWatchHistory(server.id);

    expect(await markerOf(server.id)).toBeNull();
  });

  it("on Plex, places a play on a rating key two libraries share by the play's library, and skips it otherwise", async () => {
    // Plex numbers items server-wide: one of the two rows is stale.
    const server = await createTestServer(userId, { type: "PLEX" });
    const libA = await createTestLibrary(server.id, { key: "1" });
    const libB = await createTestLibrary(server.id, { key: "2" });
    await createTestMediaItem(libA.id, { ratingKey: "100" });
    const inB = await createTestMediaItem(libB.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockResolvedValue([
      play("100", "alice", "2025-02-01T00:00:00.000Z", "2"),
      play("100", "bob", "2025-02-02T00:00:00.000Z"), // names no library
      play("100", "carol", "2025-02-03T00:00:00.000Z", "9"), // a library holding neither row
    ]);

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

    const rows = await prisma.watchHistory.findMany({ where: { mediaServerId: server.id } });
    expect(rows.map((r) => [r.mediaItemId, r.serverUsername, r.fanOutOfItemId])).toEqual([[inB.id, "alice", null]]);
  });

  it("an incremental append files a new play against both Jellyfin/Emby copies, and a re-delivered one against neither", async () => {
    // Forced on: no Jellyfin client asserts `supportsHistorySince`, but the
    // append's per-item dedup must handle a play that resolves to two items.
    mockClient.supportsHistorySince = true;
    const server = await createTestServer(userId, { type: "JELLYFIN" });
    const libA = await createTestLibrary(server.id, { key: "lib-a" });
    const libB = await createTestLibrary(server.id, { key: "lib-b" });
    const [primary, copy] = [
      await createTestMediaItem(libA.id, { ratingKey: "jf-item" }),
      await createTestMediaItem(libB.id, { ratingKey: "jf-item" }),
    ].sort((x, y) => (x.id < y.id ? -1 : 1));
    const old = new Date("2025-02-01T12:00:00.000Z");
    const fresh = new Date("2025-02-01T12:30:00.000Z");
    // Stored while the account could not be named: the re-delivered play relabels both copies.
    for (const id of [primary.id, copy.id]) {
      await prisma.watchHistory.create({
        data: {
          mediaItemId: id,
          fanOutOfItemId: id === copy.id ? primary.id : null,
          mediaServerId: server.id,
          serverUsername: "Unknown",
          watchedAt: old,
        },
      });
    }
    mockClient.getDetailedWatchHistory.mockResolvedValue([
      play("jf-item", "alice", old.toISOString()),
      play("jf-item", "alice", fresh.toISOString()),
    ]);
    const append = () => syncWatchHistory(server.id, undefined, undefined, { incremental: true });

    await expect(append()).resolves.toEqual({ count: 2 });
    // Run again: everything is already stored, for both copies.
    await expect(append()).resolves.toEqual({ count: 0 });

    const rows = await prisma.watchHistory.findMany({
      where: { mediaServerId: server.id },
      orderBy: [{ watchedAt: "asc" }, { mediaItemId: "asc" }],
      select: { mediaItemId: true, fanOutOfItemId: true, watchedAt: true, serverUsername: true },
    });
    // The new play's second copy points at its primary, as the full replace does; a relabel keeps it.
    const alice = { serverUsername: "alice" };
    expect(rows).toEqual([
      { mediaItemId: primary.id, fanOutOfItemId: null, watchedAt: old, ...alice },
      { mediaItemId: copy.id, fanOutOfItemId: primary.id, watchedAt: old, ...alice },
      { mediaItemId: primary.id, fanOutOfItemId: null, watchedAt: fresh, ...alice },
      { mediaItemId: copy.id, fanOutOfItemId: primary.id, watchedAt: fresh, ...alice },
    ]);
  });

  it("keeps a set-aside user's stored plays and stores none of what arrives for them", async () => {
    // Unlike the real clients this one still hands over an entry for bob:
    // stored on top of his kept rows, it would duplicate a play.
    const { server, item } = await serverWithItem({ type: "JELLYFIN" });
    const old = new Date("2024-12-01T00:00:00.000Z");
    for (const serverUsername of ["alice", "bob"]) {
      await prisma.watchHistory.create({
        data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername, watchedAt: old },
      });
    }
    mockClient.getDetailedWatchHistory.mockImplementation(
      async (options?: { report?: { incompleteUsers: Map<string, string> } }) => {
        options!.report!.incompleteUsers.set("bob", "unreliable");
        return [
          play("100", "alice", "2025-02-01T00:00:00.000Z"),
          play("100", "bob", "2025-02-02T00:00:00.000Z"),
        ];
      },
    );

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

    const rows = await prisma.watchHistory.findMany({
      where: { mediaServerId: server.id },
      orderBy: { serverUsername: "asc" },
    });
    expect(rows.map((r) => [r.serverUsername, r.watchedAt?.toISOString()])).toEqual([
      ["alice", "2025-02-01T00:00:00.000Z"],
      ["bob", old.toISOString()],
    ]);
  });

  it("relabels a stored Unknown play that the incremental window re-delivers named, instead of appending it", async () => {
    mockClient.supportsHistorySince = true;
    const established = new Date("2025-01-01T00:00:00Z");
    const { server, item } = await serverWithItem({ watchHistorySyncedAt: established });
    const watchedAt = new Date("2025-02-01T12:00:00.000Z");
    await prisma.watchHistory.create({
      data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "Unknown", watchedAt },
    });
    mockClient.getDetailedWatchHistory.mockResolvedValue([
      play("100", "alice", watchedAt.toISOString()),
      // A genuinely new play in the window still lands.
      play("100", "alice", "2025-02-01T12:30:00.000Z"),
    ]);

    await expect(
      syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
    ).resolves.toEqual({ count: 1 });

    const rows = await prisma.watchHistory.findMany({
      where: { mediaServerId: server.id },
      orderBy: { watchedAt: "asc" },
    });
    expect(rows.map((r) => [r.serverUsername, r.watchedAt?.toISOString()])).toEqual([
      ["alice", "2025-02-01T12:00:00.000Z"],
      ["alice", "2025-02-01T12:30:00.000Z"],
    ]);
    // The compare-and-set matched the marker read through raw SQL (a timestamp round-trip).
    expect((await markerOf(server.id))!.getTime()).toBeGreaterThan(established.getTime());
  });
});
