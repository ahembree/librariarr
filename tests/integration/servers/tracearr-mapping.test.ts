import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockInvalidateMediaCaches } = vi.hoisted(() => ({
  mockInvalidateMediaCaches: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateMediaCaches: mockInvalidateMediaCaches,
}));

const { mockTestConnection } = vi.hoisted(() => ({
  mockTestConnection: vi.fn(),
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({ testConnection: mockTestConnection })),
}));

// Records what the route asked to enqueue, and when (the queue itself: tracearr-backfill-enqueue).
const { mockEnqueueJob } = vi.hoisted(() => ({ mockEnqueueJob: vi.fn() }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

// Import route handlers AFTER mocks
import { PUT } from "@/app/api/servers/[id]/route";
import {
  markWatchHistoryEstablishedIfUnchanged,
  requireLibraryResync,
  snapshotWatchEvidence,
} from "@/lib/media/watch-evidence";
import {
  beginTracearrImport,
  endTracearrImport,
  getTracearrBackfillReach,
  getTracearrImportActivity,
  recordTracearrImportPage,
} from "@/lib/sync/tracearr-import-activity";

const TRACEARR_SERVER_A = "3f6f0d1e-0000-4000-8000-00000000000a";
const TRACEARR_SERVER_B = "3f6f0d1e-0000-4000-8000-00000000000b";

describe("PUT /api/servers/[id] — Tracearr mapping", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, name: "Test Server" });
    mockEnqueueJob.mockResolvedValue(true);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** Give a server one library, one item and `count` stored watch-history rows. */
  async function seedWatchHistory(mediaServerId: string, count = 2) {
    const library = await createTestLibrary(mediaServerId);
    const item = await createTestMediaItem(library.id);
    await prisma.watchHistory.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        mediaItemId: item.id,
        mediaServerId,
        serverUsername: `viewer-${i}`,
        watchedAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });
    return item;
  }

  const countHistory = (mediaServerId: string) =>
    prisma.watchHistory.count({ where: { mediaServerId } });

  const putMapping = (serverId: string, body: Record<string, unknown>) =>
    callRouteWithParams(
      PUT,
      { id: serverId },
      { url: `/api/servers/${serverId}`, method: "PUT", body }
    );

  async function signedInUser() {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    return user;
  }

  it("links a previously-native server and wipes its stored watch history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 3);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBe(TRACEARR_SERVER_A);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(0);
    expect(mockInvalidateMediaCaches).toHaveBeenCalled();
  });

  it("unlinking with null reverts to native history and wipes the Tracearr rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: null });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBeNull();

    expect(await countHistory(server.id)).toBe(0);
    expect(mockInvalidateMediaCaches).toHaveBeenCalled();
  });

  it("re-pointing to a different Tracearr server wipes the previous server's rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBe(TRACEARR_SERVER_B);
    expect(await countHistory(server.id)).toBe(0);
  });

  it("sending the same mapping again is a no-op that does not wipe history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    await expectJson(response, 200);

    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("sending an empty string normalises to null and unlinks", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: "" });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBeNull();
    expect(await countHistory(server.id)).toBe(0);
  });

  it("sending an empty string on an already-native server is a no-op", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: "" });
    await expectJson(response, 200);

    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("omitting the field leaves both the mapping and the history untouched", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { externalUrl: "https://plex.example.com" });
    await expectJson(response, 200);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("a url-only edit leaves the mapping and the history alone", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    // A new URL for a Plex server keeping its token needs a recent sign-in.
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await putMapping(server.id, { url: "http://plex.test:32401" });
    await expectJson(response, 200);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.url).toBe("http://plex.test:32401");
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(2);
    expect(mockTestConnection).toHaveBeenCalled();
  });

  it("does not touch another server's watch history on a mapping change", async () => {
    const user = await createTestUser();
    const switched = await createTestServer(user.id, { name: "Switched" });
    const untouched = await createTestServer(user.id, { name: "Untouched" });
    await seedWatchHistory(switched.id, 2);
    await seedWatchHistory(untouched.id, 3);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(switched.id, { tracearrServerId: TRACEARR_SERVER_A });
    await expectJson(response, 200);

    expect(await countHistory(switched.id)).toBe(0);
    expect(await countHistory(untouched.id)).toBe(3);
  });

  it("refuses a Tracearr server another media server already uses, and wipes nothing", async () => {
    // One Tracearr server's plays joined against a second server's rating keys
    // land on unrelated items there.
    const user = await createTestUser();
    const first = await createTestServer(user.id, { name: "First" });
    const second = await createTestServer(user.id, { name: "Second" });
    await prisma.mediaServer.update({
      where: { id: first.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(second.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(second.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ error: string; detail: string }>(response, 409);
    expect(body.detail).toContain("First");

    const stored = await prisma.mediaServer.findUnique({ where: { id: second.id } });
    expect(stored!.tracearrServerId).toBeNull();
    expect(await countHistory(second.id)).toBe(2);
  });

  it("lets exactly one of two concurrent PUTs map the same Tracearr server", async () => {
    // Checked outside a lock, both saw the other server unmapped; several rounds, as one interleaving proves little.
    const user = await signedInUser();

    for (let round = 0; round < 5; round++) {
      const first = await createTestServer(user.id, { name: `First ${round}` });
      const second = await createTestServer(user.id, { name: `Second ${round}` });
      const id = `3f6f0d1e-0000-4000-8000-0000000001${String(round).padStart(2, "0")}`;

      const responses = await Promise.all([
        putMapping(first.id, { tracearrServerId: id }),
        putMapping(second.id, { tracearrServerId: id }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await prisma.mediaServer.count({ where: { tracearrServerId: id } })).toBe(1);
    }
  });

  it("resets every piece of the old mapping's import state and supersedes its live run", async () => {
    // Each describes the OLD archive; carried over, the new mapping's walks would start from meaningless instants.
    const user = await signedInUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: {
        tracearrBackfillComplete: true,
        tracearrOldestPlayAt: new Date("2019-01-01T00:00:00Z"),
        tracearrBackfillCursorAt: new Date("2020-01-01T00:00:00Z"),
        tracearrForwardFloorAt: new Date("2026-01-01T00:00:00Z"),
        tracearrForwardFloorRecordedAt: new Date("2026-01-01T01:00:00Z"),
        tracearrBackfillLastWalkAt: new Date("2026-02-01T00:00:00Z"),
        tracearrForwardWatermarkAt: new Date("2026-02-01T00:00:00Z"),
      },
    });

    const run = beginTracearrImport(server.id, user.id);
    try {
      recordTracearrImportPage(run, {
        pass: "backfill",
        pages: 3,
        imported: 10,
        oldestReached: new Date("2021-01-01T00:00:00Z"),
      });
      expect(getTracearrBackfillReach(server.id)).not.toBeNull();

      await expectJson(await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B }), 200);

      // Neither the reach nor the run (whose writes are refused from here) is reported against the new mapping.
      expect(getTracearrBackfillReach(server.id)).toBeNull();
      expect(getTracearrImportActivity(server.id)).toBeNull();
    } finally {
      endTracearrImport(run);
    }

    const stored = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(stored.tracearrBackfillComplete).toBe(false);
    expect(stored.tracearrOldestPlayAt).toBeNull();
    expect(stored.tracearrBackfillCursorAt).toBeNull();
    expect(stored.tracearrForwardFloorAt).toBeNull();
    expect(stored.tracearrForwardFloorRecordedAt).toBeNull();
    // "Walked and found nothing" was about the old Tracearr server.
    expect(stored.tracearrBackfillLastWalkAt).toBeNull();
    expect(stored.tracearrForwardWatermarkAt).toBeNull();
  });

  it("withdraws the established marker in the same write that switches the source", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, {
      tracearrServerId: TRACEARR_SERVER_A,
      watchHistorySyncedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: null });
    await expectJson(response, 200);

    const stored = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(stored!.watchHistorySyncedAt).toBeNull();
  });

  // `tracearrBackfillComplete` is the one piece of import state the WatchHistory
  // rows cannot re-derive: Tracearr returns plays newest-first, so the forward
  // watermark MAX(watchedAt) is set by the FIRST page imported and says nothing
  // about how far back the walk actually got. The flag is what stops the
  // importer from re-walking the whole (possibly years-deep) history on every
  // run — which means a stale `true` is silently destructive: it tells the next
  // import "already fully walked, just fetch new plays", so everything older
  // than the switch is never imported at all, with no error anywhere. Because a
  // mapping change wipes the very rows the flag describes, the two must be reset
  // together or the flag outlives its evidence.
  describe("persisted backfill state", () => {
    const setBackfillComplete = (serverId: string, complete = true) =>
      prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: complete },
      });

    const readServer = (serverId: string) =>
      prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });

    it("defaults to false for a newly created server", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);

      // Migration 0017 adds the column `NOT NULL DEFAULT false`, deliberately:
      // an unbackfilled server re-walks (idempotent upsert — costs time, not
      // correctness), whereas defaulting true would permanently skip history.
      expect((await readServer(server.id)).tracearrBackfillComplete).toBe(false);
    });

    it("linking a server to Tracearr resets a completed backfill and wipes the rows", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      // A server that carried a completed backfill from an earlier mapping —
      // the residue this reset exists to clear.
      await setBackfillComplete(server.id);
      await seedWatchHistory(server.id, 3);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
      await expectJson(response, 200);

      // Both halves matter, and they have to move together: the rows are gone,
      // so a surviving `true` would claim a fully-walked history for a server
      // with zero stored plays.
      const updated = await readServer(server.id);
      expect(updated.tracearrServerId).toBe(TRACEARR_SERVER_A);
      expect(updated.tracearrBackfillComplete).toBe(false);
      expect(await countHistory(server.id)).toBe(0);
    });

    it("re-pointing to a different Tracearr server resets a completed backfill", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrServerId: TRACEARR_SERVER_A, tracearrBackfillComplete: true },
      });
      await seedWatchHistory(server.id, 2);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B });
      await expectJson(response, 200);

      // Tracearr -> Tracearr is the easiest transition to overlook (the source
      // is still "Tracearr"), but B's history is a different dataset entirely:
      // being fully walked on A says nothing about B.
      const updated = await readServer(server.id);
      expect(updated.tracearrServerId).toBe(TRACEARR_SERVER_B);
      expect(updated.tracearrBackfillComplete).toBe(false);
      expect(await countHistory(server.id)).toBe(0);
    });

    it("clearing the mapping resets a completed backfill", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrServerId: TRACEARR_SERVER_A, tracearrBackfillComplete: true },
      });
      await seedWatchHistory(server.id, 2);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await putMapping(server.id, { tracearrServerId: null });
      await expectJson(response, 200);

      // Going back to native history also wipes the rows, so the flag has to
      // fall with them — otherwise re-linking to Tracearr later would inherit a
      // "complete" backfill over an empty table.
      const updated = await readServer(server.id);
      expect(updated.tracearrServerId).toBeNull();
      expect(updated.tracearrBackfillComplete).toBe(false);
      expect(await countHistory(server.id)).toBe(0);
    });

    it("re-saving the same mapping keeps the completed backfill and the rows", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrServerId: TRACEARR_SERVER_A, tracearrBackfillComplete: true },
      });
      await seedWatchHistory(server.id, 2);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
      await expectJson(response, 200);

      // The reset is keyed on an actual *change*, not on the field being
      // present. Saving the server form again (a URL tweak, a token rotation)
      // re-sends the unchanged mapping; resetting there would silently kick off
      // a full multi-hour re-walk of a years-deep history on every save.
      const updated = await readServer(server.id);
      expect(updated.tracearrBackfillComplete).toBe(true);
      expect(await countHistory(server.id)).toBe(2);
    });

    it("omitting tracearrServerId leaves the completed backfill and the rows untouched", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrServerId: TRACEARR_SERVER_A, tracearrBackfillComplete: true },
      });
      await seedWatchHistory(server.id, 2);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await putMapping(server.id, { externalUrl: "https://plex.example.com" });
      await expectJson(response, 200);

      // `undefined` means the client never sent the field — an unrelated edit
      // must not touch import state at all.
      const updated = await readServer(server.id);
      expect(updated.externalUrl).toBe("https://plex.example.com");
      expect(updated.tracearrServerId).toBe(TRACEARR_SERVER_A);
      expect(updated.tracearrBackfillComplete).toBe(true);
      expect(await countHistory(server.id)).toBe(2);
    });
  });

  it("returns 401 without auth", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 2);

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");

    // The wipe sits behind the ownership check, so nothing was deleted.
    expect(await countHistory(server.id)).toBe(2);
  });

  it("returns 404 for a server owned by another user and wipes nothing", async () => {
    const owner = await createTestUser({ plexId: "owner" });
    const other = await createTestUser({ plexId: "other" });
    const server = await createTestServer(owner.id);
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: other.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");

    const untouched = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(untouched!.tracearrServerId).toBeNull();
    expect(await countHistory(server.id)).toBe(2);
  });

  describe("the wipe commits with the mapping", () => {
    // A second connection stands in for another process.
    let pool: Pool | undefined;
    const db = () => (pool ??= new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 }));

    afterAll(async () => {
      if (pool) {
        await pool.query(`DROP TRIGGER IF EXISTS refuse_wh_delete ON "WatchHistory"`).catch(() => {});
        await pool.end().catch(() => {});
      }
    });

    it("leaves the mapping, its import state and the rows untouched when the wipe fails", async () => {
      // Old rows under a new mapping would set the importer's resume boundaries.
      const user = await signedInUser();
      const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
      const walkedAt = new Date("2026-02-01T00:00:00Z");
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillComplete: true, tracearrBackfillLastWalkAt: walkedAt },
      });
      await seedWatchHistory(server.id, 2);

      await db().query(`
        CREATE OR REPLACE FUNCTION refuse_wh_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'watch history delete refused'; END $$ LANGUAGE plpgsql`);
      await db().query(`
        CREATE TRIGGER refuse_wh_delete BEFORE DELETE ON "WatchHistory"
        FOR EACH ROW EXECUTE FUNCTION refuse_wh_delete()`);
      try {
        await expect(
          putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B }),
        ).rejects.toThrow(/watch history delete refused/);
      } finally {
        await db().query(`DROP TRIGGER IF EXISTS refuse_wh_delete ON "WatchHistory"`);
      }

      const stored = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(stored.tracearrServerId).toBe(TRACEARR_SERVER_A);
      expect(stored.tracearrBackfillComplete).toBe(true);
      expect(stored.tracearrBackfillLastWalkAt?.toISOString()).toBe(walkedAt.toISOString());
      expect(await countHistory(server.id)).toBe(2);
    });

    it.each<[string, string | null, string, (w: PoolClient, itemId: string, serverId: string) => Promise<unknown>]>([
      [
        "a Tracearr page mid-write (holding the server row FOR SHARE, as writeBatch does)",
        TRACEARR_SERVER_A,
        TRACEARR_SERVER_B,
        async (w, itemId, serverId) => {
          await w.query(`SELECT "id" FROM "MediaServer" WHERE "id" = $1 AND "tracearrServerId" = $2 FOR SHARE`, [
            serverId,
            TRACEARR_SERVER_A,
          ]);
          await w.query(
            `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId")
             VALUES ('in-flight', $1, $2, 'viewer', now(), 'TRACEARR', 'chain-in-flight')`,
            [itemId, serverId],
          );
        },
      ],
      [
        "a native full replace in flight (its history lock, DELETE and INSERT)",
        null,
        TRACEARR_SERVER_A,
        async (w, itemId, serverId) => {
          await w.query(`SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`, [serverId]);
          await w.query(`DELETE FROM "WatchHistory" WHERE "mediaServerId" = $1`, [serverId]);
          await w.query(
            `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source")
             VALUES ('native-new', $1, $2, 'viewer', now(), 'NATIVE')`,
            [itemId, serverId],
          );
        },
      ],
    ])("waits for %s and wipes what it wrote", async (_, from, to, write) => {
      const user = await signedInUser();
      const server = await createTestServer(user.id, { tracearrServerId: from });
      const item = await seedWatchHistory(server.id, 1);

      const writer = await db().connect();
      try {
        await writer.query("BEGIN");
        await write(writer, item.id, server.id);

        const put = putMapping(server.id, { tracearrServerId: to });
        // Let the PUT reach the lock before the writer commits.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writer.query("COMMIT");

        await expectJson(await put, 200);
      } finally {
        writer.release();
      }

      expect(await countHistory(server.id)).toBe(0);
      const stored = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(stored.tracearrServerId).toBe(to);
    });
  });

  it("keeps a library-resync hold across a mapping change, and an unlink", async () => {
    // The hold is about the purged library, not the mapping.
    const user = await signedInUser();
    const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
    await requireLibraryResync([server.id]);
    const held = (await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } }))
      .libraryResyncRequiredAt;
    expect(held).toBeInstanceOf(Date);

    for (const tracearrServerId of [TRACEARR_SERVER_A, TRACEARR_SERVER_B, null]) {
      await expectJson(await putMapping(server.id, { tracearrServerId }), 200);
      const row = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(row.libraryResyncRequiredAt, String(tracearrServerId)).toEqual(held);
    }
  });

  describe("the mapping version and the forward watermark", () => {
    const read = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });

    it("bumps the version on a link, a re-point and an unlink — and on a re-link to the same server", async () => {
      // A re-link leaves the mapping value as it was: only the version tells an older slice its state was reset.
      const user = await signedInUser();
      const server = await createTestServer(user.id);
      expect((await read(server.id)).tracearrMappingVersion).toBe(0);

      for (const [i, tracearrServerId] of [TRACEARR_SERVER_A, TRACEARR_SERVER_B, null, TRACEARR_SERVER_B].entries()) {
        // The forward watermark records how far the OLD archive was read.
        await prisma.mediaServer.update({
          where: { id: server.id },
          data: { tracearrForwardWatermarkAt: new Date("2026-02-01T00:00:00Z") },
        });
        await expectJson(await putMapping(server.id, { tracearrServerId }), 200);
        const row = await read(server.id);
        expect(row.tracearrMappingVersion).toBe(i + 1);
        expect(row.tracearrForwardWatermarkAt).toBeNull();
      }
    });

    it("leaves the version, the watermark and the last walk alone on a re-save of the same mapping, an empty string on a native server and unrelated edits", async () => {
      const user = await signedInUser();
      const mapped = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
      const native = await createTestServer(user.id);
      const walkedAt = new Date("2026-02-01T00:00:00Z");
      await prisma.mediaServer.update({
        where: { id: mapped.id },
        data: { tracearrBackfillLastWalkAt: walkedAt, tracearrForwardWatermarkAt: walkedAt },
      });

      await expectJson(await putMapping(mapped.id, { tracearrServerId: TRACEARR_SERVER_A }), 200);
      await expectJson(await putMapping(mapped.id, { externalUrl: "https://plex.example.com" }), 200);
      await expectJson(await putMapping(mapped.id, { enabled: false }), 200);
      await expectJson(await putMapping(mapped.id, { enabled: true }), 200);
      await expectJson(await putMapping(native.id, { tracearrServerId: "" }), 200);

      const row = await read(mapped.id);
      expect(row.tracearrMappingVersion).toBe(0);
      expect(row.tracearrBackfillLastWalkAt?.toISOString()).toBe(walkedAt.toISOString());
      expect(row.tracearrForwardWatermarkAt).toEqual(walkedAt);
      expect((await read(native.id)).tracearrMappingVersion).toBe(0);
    });

    it("refuses to bump the version when the mapping is refused as taken", async () => {
      const user = await signedInUser();
      await createTestServer(user.id, { name: "Owner", tracearrServerId: TRACEARR_SERVER_A });
      const other = await createTestServer(user.id, { name: "Other" });

      await expectJson(await putMapping(other.id, { tracearrServerId: TRACEARR_SERVER_A }), 409);

      expect((await read(other.id)).tracearrMappingVersion).toBe(0);
    });
  });

  describe("disabling with deleteData", () => {
    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS put_record_hold ON "MediaItem"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_put_hold_at_delete"`);
    });

    it("holds the server before deleting its items, withdraws its marker and restarts a mapped walk", async () => {
      const user = await signedInUser();
      const established = new Date("2026-01-01T00:00:00Z");
      const server = await createTestServer(user.id, {
        tracearrServerId: TRACEARR_SERVER_A,
        tracearrBackfillComplete: true,
        watchHistorySyncedAt: established,
      });
      await seedWatchHistory(server.id, 2);
      // A shortfall recorded against the rows about to be deleted.
      await prisma.library.updateMany({ where: { mediaServerId: server.id }, data: { shortPassSeenAt: new Date() } });
      // A history pass that started before the disable, still fetching.
      const inFlight = snapshotWatchEvidence(server.id, established);
      // Records the server's hold at the moment each item row is deleted.
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "_put_hold_at_delete" ("mediaItemId" text, "hold" timestamp(3))`,
      );
      await prisma.$executeRawUnsafe(`TRUNCATE "_put_hold_at_delete"`);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION _put_record_hold() RETURNS trigger AS $$
        BEGIN
          INSERT INTO "_put_hold_at_delete"
            SELECT OLD."id", ms."libraryResyncRequiredAt"
              FROM "Library" l JOIN "MediaServer" ms ON ms."id" = l."mediaServerId"
             WHERE l."id" = OLD."libraryId";
          RETURN OLD;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS put_record_hold ON "MediaItem"`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER put_record_hold BEFORE DELETE ON "MediaItem" FOR EACH ROW EXECUTE FUNCTION _put_record_hold()`,
      );
      const before = Date.now();

      try {
        await expectJson(await putMapping(server.id, { enabled: false, deleteData: true }), 200);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS put_record_hold ON "MediaItem"`);
      }

      const atDelete = await prisma.$queryRawUnsafe<{ hold: Date | null }[]>(
        `SELECT "hold" FROM "_put_hold_at_delete"`,
      );
      expect(atDelete).toHaveLength(1);
      expect(atDelete[0].hold).toBeInstanceOf(Date);
      expect(await prisma.mediaItem.count({ where: { library: { mediaServerId: server.id } } })).toBe(0);

      const row = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(row.libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(row.watchHistorySyncedAt).toBeNull();
      expect(row.tracearrBackfillComplete).toBe(false);
      expect(row.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(row.tracearrForwardWatermarkAt).toEqual(row.tracearrBackfillCursorAt);
      await expect(markWatchHistoryEstablishedIfUnchanged(inFlight)).resolves.toBe(false);
      // ...and it must not count toward releasing the hold its refill waits on.
      expect(
        (await prisma.library.findMany({ where: { mediaServerId: server.id } })).map((l) => l.shortPassSeenAt),
      ).toEqual([null]);
    });

    it("holds nothing when the server has no libraries to purge, or is only disabled", async () => {
      const user = await signedInUser();
      const bare = await createTestServer(user.id, { name: "Bare" });
      const kept = await createTestServer(user.id, { name: "Kept" });
      await seedWatchHistory(kept.id, 1);

      await expectJson(await putMapping(bare.id, { enabled: false, deleteData: true }), 200);
      await expectJson(await putMapping(kept.id, { enabled: false }), 200);

      for (const id of [bare.id, kept.id]) {
        const row = await prisma.mediaServer.findUniqueOrThrow({ where: { id } });
        expect(row.libraryResyncRequiredAt).toBeNull();
        expect(row.watchHistorySyncedAt).not.toBeNull();
      }
      expect(await countHistory(kept.id)).toBe(1);
    });
  });

  describe("queues the import the save was waiting on", () => {
    const enableInstance = (userId: string, enabled = true) =>
      prisma.tracearrInstance.create({
        data: { userId, name: "Tracearr", url: "http://tracearr.test", apiKey: "key", enabled },
      });
    const backfillEnqueues = () =>
      mockEnqueueJob.mock.calls.filter(([task]) => task === "tracearr-backfill");
    const expectQueuedFor = (serverId: string) =>
      expect(backfillEnqueues()).toEqual([
        [
          "tracearr-backfill",
          { serverId },
          { jobKey: `tracearr-backfill:${serverId}`, queueName: "librariarr:main", maxAttempts: 3 },
        ],
      ]);

    it("queues the first slice of a new mapping after the mapping has committed, and again on a re-point", async () => {
      const user = await signedInUser();
      await enableInstance(user.id);
      const server = await createTestServer(user.id);
      await seedWatchHistory(server.id);
      // The slice reads the mapping from the database: never queued inside the transaction.
      let mappingAtEnqueue: string | null | undefined;
      mockEnqueueJob.mockImplementation(async () => {
        mappingAtEnqueue = (await prisma.mediaServer.findUnique({ where: { id: server.id } }))?.tracearrServerId;
        return true;
      });

      await expectJson(await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A }), 200);
      expectQueuedFor(server.id);
      expect(mappingAtEnqueue).toBe(TRACEARR_SERVER_A);

      mockEnqueueJob.mockClear();
      await expectJson(await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B }), 200);
      expectQueuedFor(server.id);
    });

    it("queues nothing on an unlink, a re-save of the same mapping, an unrelated edit, or a link in a save that also disables", async () => {
      const user = await signedInUser();
      await enableInstance(user.id);
      const kept = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
      await seedWatchHistory(kept.id);
      const unlinked = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_B });
      await seedWatchHistory(unlinked.id);
      const disabling = await createTestServer(user.id);
      await seedWatchHistory(disabling.id);

      await expectJson(await putMapping(kept.id, { tracearrServerId: TRACEARR_SERVER_A }), 200);
      await expectJson(await putMapping(kept.id, { url: "http://plex.test:32400" }), 200);
      await expectJson(await putMapping(unlinked.id, { tracearrServerId: null }), 200);
      await expectJson(await putMapping(disabling.id, { tracearrServerId: TRACEARR_SERVER_B, enabled: false }), 200);

      expect(backfillEnqueues()).toEqual([]);
    });

    it("queues nothing without an enabled Tracearr instance, or for a server with no items", async () => {
      const user = await signedInUser();
      await enableInstance(user.id, false);
      const noInstance = await createTestServer(user.id);
      await seedWatchHistory(noInstance.id);
      await expectJson(await putMapping(noInstance.id, { tracearrServerId: TRACEARR_SERVER_A }), 200);

      const other = await createTestUser();
      await enableInstance(other.id);
      const empty = await createTestServer(other.id);
      setMockSession({ userId: other.id, plexToken: "tok", isLoggedIn: true });
      await expectJson(await putMapping(empty.id, { tracearrServerId: TRACEARR_SERVER_B }), 200);

      expect(backfillEnqueues()).toEqual([]);
    });

    it("queues a mapped server's slice when it is re-enabled — a transition, not every save — and nothing on disable or for an unmapped server", async () => {
      const user = await signedInUser();
      await enableInstance(user.id);
      const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
      await seedWatchHistory(server.id);
      const unmapped = await createTestServer(user.id, { enabled: false });
      await seedWatchHistory(unmapped.id);

      await expectJson(await putMapping(server.id, { enabled: false }), 200);
      await expectJson(await putMapping(unmapped.id, { enabled: true }), 200);
      expect(backfillEnqueues()).toEqual([]);

      await expectJson(await putMapping(server.id, { enabled: true }), 200);
      expectQueuedFor(server.id);

      mockEnqueueJob.mockClear();
      await expectJson(await putMapping(server.id, { enabled: true }), 200);
      expect(backfillEnqueues()).toEqual([]);
    });

    it("does not start a purged server's walk ahead of the re-sync when it is re-enabled", async () => {
      // Walked before a sync brings the items back, their plays would be skipped for good.
      const user = await signedInUser();
      await enableInstance(user.id);
      const server = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_A });
      await seedWatchHistory(server.id);

      await expectJson(await putMapping(server.id, { enabled: false, deleteData: true }), 200);
      await expectJson(await putMapping(server.id, { enabled: true }), 200);
      expect(backfillEnqueues()).toEqual([]);

      // The same for a partial purge, where other items remain.
      const partial = await createTestServer(user.id, { tracearrServerId: TRACEARR_SERVER_B });
      await seedWatchHistory(partial.id);
      await prisma.mediaServer.update({
        where: { id: partial.id },
        data: { enabled: false, tracearrBackfillLastWalkAt: new Date() },
      });
      await requireLibraryResync([partial.id]);
      await expectJson(await putMapping(partial.id, { enabled: true }), 200);
      expect(backfillEnqueues()).toEqual([]);
    });

    it("still saves when the enqueue fails", async () => {
      const user = await signedInUser();
      await enableInstance(user.id);
      const server = await createTestServer(user.id);
      await seedWatchHistory(server.id);
      mockEnqueueJob.mockRejectedValue(new Error("queue down"));

      await expectJson(await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A }), 200);
      const stored = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
      expect(stored.tracearrServerId).toBe(TRACEARR_SERVER_A);
    });
  });
});
