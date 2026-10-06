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
 *    skipped — never filed against whichever row a query returned last;
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

  it("places a play on a rating key two libraries share by the play's library, and skips it otherwise", async () => {
    const server = await createTestServer(userId);
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
