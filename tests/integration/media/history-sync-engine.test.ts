/**
 * The History page's Refresh (`POST /api/media/history/sync`) over the REAL
 * native sync engine against a real database — only the media-server client is
 * faked. `history-sync.test.ts` covers the route's stream plumbing with the
 * engine stubbed; this file covers what the two only show together:
 *
 *  - a failed fetch is reported as a failed server (-1), not a clean zero, and
 *    leaves the stored rows and the established marker exactly as they were;
 *  - a withdrawal (purge, source switch) landing while the fetch runs is not
 *    overwritten by the finishing sync;
 *  - a rating key held by two libraries is placed by the play's library, or
 *    skipped on Plex (a stale row) — and on Jellyfin/Emby, which report no
 *    library, filed against every copy — never against whichever row a query
 *    returned last;
 *  - the incremental append recognises a play stored as "Unknown" that comes
 *    back named, and relabels it instead of storing it twice.
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

  it("reports a server whose fetch failed as failed, and leaves its history untouched", async () => {
    const established = new Date("2025-01-01T00:00:00Z");
    const server = await createTestServer(userId, { watchHistorySyncedAt: established });
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id, { ratingKey: "100" });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: item.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2024-12-01T00:00:00Z"),
      },
    });
    mockClient.getDetailedWatchHistory.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { result } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
    );

    // Before: `{ count: 0 }` came back and the page reported a clean sync.
    expect(result.counts).toEqual({ [server.id]: -1 });
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(1);
    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.watchHistorySyncedAt).toEqual(established);
  });

  it("stores the plays and establishes the history on success", async () => {
    const server = await createTestServer(userId, { watchHistorySyncedAt: null });
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockResolvedValue([play("100", "alice", "2025-02-01T00:00:00.000Z")]);

    const { result } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
    );

    expect(result.counts).toEqual({ [server.id]: 1 });
    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("does not re-establish a history withdrawn while the fetch was running", async () => {
    // A purge during the fetch withdrew the marker (already null here — a
    // first sync). The finishing sync used to write it unconditionally.
    const server = await createTestServer(userId, { watchHistorySyncedAt: null });
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockImplementation(async () => {
      await invalidateWatchHistoryEvidence([server.id]);
      return [play("100", "alice", "2025-02-01T00:00:00.000Z")];
    });

    await syncWatchHistory(server.id);

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.watchHistorySyncedAt).toBeNull();
  });

  it("does not re-establish an established history withdrawn mid-fetch by a direct write", async () => {
    // The established → null case is caught by the compare-and-set itself,
    // whoever wrote the null (here: a raw update, like the server PUT's).
    const server = await createTestServer(userId, { watchHistorySyncedAt: new Date("2025-01-01T00:00:00Z") });
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockImplementation(async () => {
      await prisma.mediaServer.update({ where: { id: server.id }, data: { watchHistorySyncedAt: null } });
      return [play("100", "alice", "2025-02-01T00:00:00.000Z")];
    });

    await syncWatchHistory(server.id);

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.watchHistorySyncedAt).toBeNull();
  });

  it("on Plex, places a play on a rating key two libraries share by the play's library, and skips it otherwise", async () => {
    // Plex numbers items server-wide, so one of the two rows is stale and only
    // the play's own library can say which.
    const server = await createTestServer(userId, { type: "PLEX" });
    const libA = await createTestLibrary(server.id, { key: "1" });
    const libB = await createTestLibrary(server.id, { key: "2" });
    const inA = await createTestMediaItem(libA.id, { ratingKey: "100" });
    const inB = await createTestMediaItem(libB.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockResolvedValue([
      play("100", "alice", "2025-02-01T00:00:00.000Z", "2"),
      play("100", "bob", "2025-02-02T00:00:00.000Z"), // names no library: ambiguous
    ]);

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

    const rows = await prisma.watchHistory.findMany({ where: { mediaServerId: server.id } });
    expect(rows.map((r) => [r.mediaItemId, r.serverUsername])).toEqual([[inB.id, "alice"]]);
    expect(rows.some((r) => r.mediaItemId === inA.id)).toBe(false);
  });

  it("on Plex, skips a play whose library holds neither row with its rating key", async () => {
    const server = await createTestServer(userId, { type: "PLEX" });
    const libA = await createTestLibrary(server.id, { key: "1" });
    const libB = await createTestLibrary(server.id, { key: "2" });
    await createTestMediaItem(libA.id, { ratingKey: "100" });
    await createTestMediaItem(libB.id, { ratingKey: "100" });
    mockClient.getDetailedWatchHistory.mockResolvedValue([play("100", "alice", "2025-02-01T00:00:00.000Z", "9")]);

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0 });
  });

  describe("Jellyfin/Emby: one item listed by two libraries", () => {
    // Two libraries covering the same folder list the SAME item id, which we
    // store once per library. The server never reports a section, so the play
    // used to be skipped as ambiguous — and the full replace had already
    // deleted both copies' rows, so both read as never watched.
    async function twoCopies(type: "JELLYFIN" | "EMBY") {
      const server = await createTestServer(userId, { type });
      const libA = await createTestLibrary(server.id, { key: "lib-a" });
      const libB = await createTestLibrary(server.id, { key: "lib-b" });
      const inA = await createTestMediaItem(libA.id, { ratingKey: "jf-item" });
      const inB = await createTestMediaItem(libB.id, { ratingKey: "jf-item" });
      const other = await createTestMediaItem(libA.id, { ratingKey: "jf-other" });
      return { server, inA, inB, other };
    }

    it.each(["JELLYFIN", "EMBY"] as const)("%s full replace files every play against both copies", async (type) => {
      const { server, inA, inB, other } = await twoCopies(type);
      // A stored play from before: the full replace must put it back on both.
      await prisma.watchHistory.create({
        data: { mediaItemId: inA.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date("2024-01-01T00:00:00Z") },
      });
      mockClient.getDetailedWatchHistory.mockResolvedValue([
        // PlayCount 2: the dated play plus one undated.
        play("jf-item", "alice", "2025-02-01T00:00:00.000Z"),
        { ...play("jf-item", "alice", "2025-02-01T00:00:00.000Z"), watchedAt: null },
        play("jf-other", "bob", "2025-02-03T00:00:00.000Z"),
      ]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 5 });

      const count = (id: string) => prisma.watchHistory.count({ where: { mediaItemId: id } });
      expect(await count(inA.id)).toBe(2);
      expect(await count(inB.id)).toBe(2);
      expect(await count(other.id)).toBe(1);
      // And reconciled onto both rows, which is what the rules read.
      const items = await prisma.mediaItem.findMany({
        where: { id: { in: [inA.id, inB.id] } },
        select: { playCount: true, lastPlayedAt: true },
      });
      for (const item of items) {
        expect(item.playCount).toBe(2);
        expect(item.lastPlayedAt?.toISOString()).toBe("2025-02-01T00:00:00.000Z");
      }
    });

    it("an incremental append files a new play against both copies, and a re-delivered one against neither", async () => {
      // No Jellyfin client asserts `supportsHistorySince` today; forced here
      // so the append's per-item dedup is exercised with a play that resolves
      // to two items.
      mockClient.supportsHistorySince = true;
      const { server, inA, inB } = await twoCopies("JELLYFIN");
      const old = new Date("2025-02-01T12:00:00.000Z");
      for (const id of [inA.id, inB.id]) {
        await prisma.watchHistory.create({
          data: { mediaItemId: id, mediaServerId: server.id, serverUsername: "alice", watchedAt: old },
        });
      }
      mockClient.getDetailedWatchHistory.mockResolvedValue([
        play("jf-item", "alice", old.toISOString()),
        play("jf-item", "alice", "2025-02-01T12:30:00.000Z"),
      ]);

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 2 });
      // Run again: everything is already stored, for both copies.
      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 0 });

      for (const id of [inA.id, inB.id]) {
        const rows = await prisma.watchHistory.findMany({ where: { mediaItemId: id }, orderBy: { watchedAt: "asc" } });
        expect(rows.map((r) => r.watchedAt?.toISOString())).toEqual([
          "2025-02-01T12:00:00.000Z",
          "2025-02-01T12:30:00.000Z",
        ]);
      }
    });

    it("an incremental append points a new play's second copy at its primary, as the full replace does", async () => {
      mockClient.supportsHistorySince = true;
      const { server, inA, inB } = await twoCopies("JELLYFIN");
      const [primary, copy] = [inA, inB].sort((x, y) => (x.id < y.id ? -1 : 1));
      await prisma.watchHistory.create({
        data: { mediaItemId: primary.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date("2025-02-01T12:00:00.000Z") },
      });
      mockClient.getDetailedWatchHistory.mockResolvedValue([play("jf-item", "alice", "2025-02-01T12:30:00.000Z")]);

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 2 });

      const appended = await prisma.watchHistory.findMany({
        where: { mediaServerId: server.id, watchedAt: new Date("2025-02-01T12:30:00.000Z") },
        select: { mediaItemId: true, fanOutOfItemId: true },
      });
      expect(appended.sort((x, y) => (x.mediaItemId < y.mediaItemId ? -1 : 1))).toEqual([
        { mediaItemId: primary.id, fanOutOfItemId: null },
        { mediaItemId: copy.id, fanOutOfItemId: primary.id },
      ]);
    });

    it("an incremental append relabels a stored Unknown play on both copies, keeping which is primary", async () => {
      mockClient.supportsHistorySince = true;
      const { server, inA, inB } = await twoCopies("JELLYFIN");
      const [primary, copy] = [inA, inB].sort((x, y) => (x.id < y.id ? -1 : 1));
      const watchedAt = new Date("2025-02-01T12:00:00.000Z");
      await prisma.watchHistory.create({
        data: { mediaItemId: primary.id, mediaServerId: server.id, serverUsername: "Unknown", watchedAt },
      });
      await prisma.watchHistory.create({
        data: { mediaItemId: copy.id, fanOutOfItemId: primary.id, mediaServerId: server.id, serverUsername: "Unknown", watchedAt },
      });
      mockClient.getDetailedWatchHistory.mockResolvedValue([play("jf-item", "alice", watchedAt.toISOString())]);

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 0 });

      const rows = await prisma.watchHistory.findMany({
        where: { mediaServerId: server.id },
        select: { mediaItemId: true, fanOutOfItemId: true, serverUsername: true },
      });
      expect(rows.sort((x, y) => (x.mediaItemId < y.mediaItemId ? -1 : 1))).toEqual([
        { mediaItemId: primary.id, fanOutOfItemId: null, serverUsername: "alice" },
        { mediaItemId: copy.id, fanOutOfItemId: primary.id, serverUsername: "alice" },
      ]);
    });
  });

  it("keeps a set-aside user's stored plays and stores none of what arrives for them", async () => {
    // The client reports bob incomplete but (unlike the real ones) still hands
    // over an entry for him: stored on top of the rows kept for him, it would
    // duplicate a play.
    const server = await createTestServer(userId, { type: "JELLYFIN" });
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id, { ratingKey: "100" });
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
    const server = await createTestServer(userId, { watchHistorySyncedAt: new Date("2025-01-01T00:00:00Z") });
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id, { ratingKey: "100" });
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
    // The compare-and-set matched the marker the run read through raw SQL
    // (a timestamp round-trip), so the history was re-established.
    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.watchHistorySyncedAt!.getTime()).toBeGreaterThan(new Date("2025-01-01T00:00:00Z").getTime());
  });
});
