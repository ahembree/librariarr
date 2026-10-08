import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { DELETE } from "@/app/api/media/purge/route";
import { markWatchHistoryEstablishedIfUnchanged, snapshotWatchEvidence } from "@/lib/media/watch-evidence";

/** Records each deleted MediaItem's server hold AT THE MOMENT of the delete: the hold must come first. */
async function recordHoldAtDelete() {
  const prisma = getTestPrisma();
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "_purge_hold_at_delete" ("mediaItemId" text, "serverId" text, "hold" timestamp(3))`,
  );
  await prisma.$executeRawUnsafe(`TRUNCATE "_purge_hold_at_delete"`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION _purge_record_hold() RETURNS trigger AS $$
    BEGIN
      INSERT INTO "_purge_hold_at_delete"
        SELECT OLD."id", ms."id", ms."libraryResyncRequiredAt"
          FROM "Library" l JOIN "MediaServer" ms ON ms."id" = l."mediaServerId"
         WHERE l."id" = OLD."libraryId";
      RETURN OLD;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS purge_record_hold ON "MediaItem"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER purge_record_hold BEFORE DELETE ON "MediaItem" FOR EACH ROW EXECUTE FUNCTION _purge_record_hold()`,
  );
}

async function holdsAtDelete() {
  return getTestPrisma().$queryRawUnsafe<{ mediaItemId: string; serverId: string; hold: Date | null }[]>(
    `SELECT "mediaItemId","serverId","hold" FROM "_purge_hold_at_delete"`,
  );
}

describe("DELETE /api/media/purge", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const prisma = getTestPrisma();
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS purge_record_hold ON "MediaItem"`);
  });

  afterAll(async () => {
    await getTestPrisma().$executeRawUnsafe(`DROP TABLE IF EXISTS "_purge_hold_at_delete"`);
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 with missing type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("returns 400 with invalid type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("deletes items of specified type and returns count", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    // Create 3 movies and 2 series items
    await createTestMediaItem(movieLib.id, { title: "Movie 1", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 2", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 3", type: "MOVIE" });
    await createTestMediaItem(seriesLib.id, { title: "Series 1", type: "SERIES" });
    await createTestMediaItem(seriesLib.id, { title: "Series 2", type: "SERIES" });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ deleted: number }>(response, 200);
    expect(body.deleted).toBe(3);

    // Verify movies are deleted but series items remain
    const remainingMovies = await prisma.mediaItem.count({
      where: { library: { type: "MOVIE" } },
    });
    expect(remainingMovies).toBe(0);

    const remainingSeries = await prisma.mediaItem.count({
      where: { library: { type: "SERIES" } },
    });
    expect(remainingSeries).toBe(2);
  });

  it("does not affect other user's items", async () => {
    const prisma = getTestPrisma();
    const user1 = await createTestUser({ plexId: "user1" });
    const user2 = await createTestUser({ plexId: "user2" });

    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);

    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createTestMediaItem(lib1.id, { title: "User1 Movie", type: "MOVIE" });
    await createTestMediaItem(lib2.id, { title: "User2 Movie", type: "MOVIE" });

    setMockSession({ isLoggedIn: true, userId: user1.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ deleted: number }>(response, 200);
    expect(body.deleted).toBe(1);

    // User2's movie should still exist
    const user2Movies = await prisma.mediaItem.count({
      where: { libraryId: lib2.id },
    });
    expect(user2Movies).toBe(1);
  });

  it("recomputes canonical so the surviving duplicate stays visible after a per-library purge", async () => {
    const prisma = getTestPrisma();
    const { recomputeCanonical } = await import("@/lib/dedup/recompute-canonical");
    const user = await createTestUser();

    // Two servers with the SAME movie (same title+year → same dedupKey).
    const serverA = await createTestServer(user.id, { name: "Server A" });
    const serverB = await createTestServer(user.id, { name: "Server B" });
    const libA = await createTestLibrary(serverA.id, { type: "MOVIE" });
    const libB = await createTestLibrary(serverB.id, { type: "MOVIE" });
    await createTestMediaItem(libA.id, { title: "Dup Movie", year: 2020, type: "MOVIE" });
    await createTestMediaItem(libB.id, { title: "Dup Movie", year: 2020, type: "MOVIE" });

    // Establish canonical selection, then purge whichever library holds it.
    await recomputeCanonical(user.id);
    const canonical = await prisma.mediaItem.findFirst({ where: { dedupCanonical: true } });
    expect(canonical).not.toBeNull();

    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { libraryId: canonical!.libraryId },
    });
    await expectJson<{ deleted: number }>(response, 200);

    // The surviving copy must now be canonical (otherwise it vanishes from
    // multi-server listings, which filter dedupCanonical = true).
    const survivors = await prisma.mediaItem.findMany();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].dedupCanonical).toBe(true);
  });
  it("restarts the Tracearr archive walk for a mapped server, leaving others alone", async () => {
    // The purge cascades the items' plays away, and a "complete" backfill only
    // ever runs the one-hour forward pass — so those plays, which Tracearr
    // still holds, were never imported again.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const mapped = await createTestServer(user.id, {
      name: "Mapped",
      tracearrServerId: "11111111-2222-3333-4444-555555555555",
      tracearrBackfillComplete: true,
    });
    const native = await createTestServer(user.id, { name: "Native" });
    const mappedLib = await createTestLibrary(mapped.id, { type: "MOVIE" });
    const nativeLib = await createTestLibrary(native.id, { type: "MOVIE" });
    await createTestMediaItem(mappedLib.id, { title: "A", type: "MOVIE" });
    await createTestMediaItem(nativeLib.id, { title: "B", type: "MOVIE" });

    setMockSession({ isLoggedIn: true, userId: user.id });
    const before = Date.now();
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    await expectJson<{ deleted: number }>(response, 200);

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: mapped.id } });
    expect(after.tracearrBackfillComplete).toBe(false);
    // Moved to now so the walk starts from the newest play again.
    expect(after.tracearrBackfillCursorAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.tracearrForwardWatermarkAt).toEqual(after.tracearrBackfillCursorAt);
    // Held until a full sync re-adds the items, or the walk would skip their plays.
    expect(after.libraryResyncRequiredAt).toBeInstanceOf(Date);

    const untouched = await prisma.mediaServer.findUniqueOrThrow({ where: { id: native.id } });
    expect(untouched.tracearrBackfillCursorAt).toBeNull();
    expect(untouched.libraryResyncRequiredAt).toBeInstanceOf(Date);
  });

  it("restarts the Tracearr archive walk on a per-library purge", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const mapped = await createTestServer(user.id, {
      tracearrServerId: "11111111-2222-3333-4444-555555555555",
      tracearrBackfillComplete: true,
    });
    const lib = await createTestLibrary(mapped.id, { type: "SERIES" });
    await createTestMediaItem(lib.id, { title: "Pilot", type: "SERIES" });

    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { libraryId: lib.id },
    });
    await expectJson<{ deleted: number }>(response, 200);

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: mapped.id } });
    expect(after.tracearrBackfillComplete).toBe(false);
    expect(after.tracearrBackfillCursorAt).toBeInstanceOf(Date);
    expect(after.libraryResyncRequiredAt).toBeInstanceOf(Date);
  });

  describe("the library-resync hold", () => {
    const prisma = getTestPrisma();
    const purge = (searchParams: Record<string, string>) =>
      callRoute(DELETE, { url: "/api/media/purge", method: "DELETE", searchParams });
    const server = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });

    it("holds the purged library's server before its items are deleted; no history pass can vouch for the gap", async () => {
      const user = await createTestUser();
      const established = new Date("2026-01-01T00:00:00Z");
      const purged = await createTestServer(user.id, { name: "Purged", watchHistorySyncedAt: established });
      const other = await createTestServer(user.id, { name: "Other" });
      const lib = await createTestLibrary(purged.id, { type: "MOVIE" });
      const otherLib = await createTestLibrary(other.id, { type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "A", type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "B", type: "MOVIE" });
      await createTestMediaItem(otherLib.id, { title: "C", type: "MOVIE" });
      await recordHoldAtDelete();
      // A native full replace that started before the purge, still fetching.
      const inFlight = snapshotWatchEvidence(purged.id, established);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const body = await expectJson<{ deleted: number }>(await purge({ libraryId: lib.id }), 200);
      expect(body.deleted).toBe(2);

      const atDelete = await holdsAtDelete();
      expect(atDelete).toHaveLength(2);
      for (const row of atDelete) expect(row.hold).toBeInstanceOf(Date);
      const after = await server(purged.id);
      expect(after.libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(after.watchHistorySyncedAt).toBeNull();
      await expect(markWatchHistoryEstablishedIfUnchanged(inFlight)).resolves.toBe(false);
      // ...nor one that starts after it, while held.
      await expect(markWatchHistoryEstablishedIfUnchanged(snapshotWatchEvidence(purged.id, null))).resolves.toBe(false);
      expect((await server(purged.id)).watchHistorySyncedAt).toBeNull();
      const untouched = await server(other.id);
      expect(untouched.libraryResyncRequiredAt).toBeNull();
      expect(untouched.watchHistorySyncedAt).not.toBeNull();
    });

    it("type-wide: holds the servers owning an ENABLED purged library before the delete, only withdraws for the rest", async () => {
      const user = await createTestUser();
      const both = await createTestServer(user.id, { name: "Enabled and disabled" });
      const disabledOnly = await createTestServer(user.id, { name: "Disabled only" });
      const seriesOnly = await createTestServer(user.id, { name: "Series only" });
      const enabledLib = await createTestLibrary(both.id, { type: "MOVIE", key: "1" });
      const disabledLib = await createTestLibrary(both.id, { type: "MOVIE", key: "2" });
      const offLib = await createTestLibrary(disabledOnly.id, { type: "MOVIE" });
      const seriesLib = await createTestLibrary(seriesOnly.id, { type: "SERIES" });
      for (const lib of [enabledLib, disabledLib, offLib]) {
        await createTestMediaItem(lib.id, { title: `In ${lib.id}`, type: "MOVIE" });
      }
      await createTestMediaItem(seriesLib.id, { title: "Pilot", type: "SERIES" });
      await prisma.library.updateMany({
        where: { id: { in: [disabledLib.id, offLib.id] } },
        data: { enabled: false },
      });
      await recordHoldAtDelete();

      setMockSession({ isLoggedIn: true, userId: user.id });
      const body = await expectJson<{ deleted: number }>(await purge({ type: "MOVIE" }), 200);
      expect(body.deleted).toBe(3);

      const held = await server(both.id);
      expect(held.libraryResyncRequiredAt).toBeInstanceOf(Date);
      expect(held.watchHistorySyncedAt).toBeNull();
      // Held before ANY of its rows went, the disabled library's included.
      const bothAtDelete = (await holdsAtDelete()).filter((r) => r.serverId === both.id);
      expect(bothAtDelete).toHaveLength(2);
      for (const row of bothAtDelete) expect(row.hold).toBeInstanceOf(Date);

      const withdrawn = await server(disabledOnly.id);
      expect(withdrawn.libraryResyncRequiredAt).toBeNull();
      expect(withdrawn.watchHistorySyncedAt).toBeNull();
      // Nothing of this server was purged: its play-activity rules keep going.
      const spared = await server(seriesOnly.id);
      expect(spared.libraryResyncRequiredAt).toBeNull();
      expect(spared.watchHistorySyncedAt).not.toBeNull();
    });

    it("holds nothing for a DISABLED library — it only withdraws the marker, and restarts no walk", async () => {
      // Nothing re-adds a disabled library's items; re-enabling it populates an empty library, which holds then.
      const user = await createTestUser();
      const mapped = await createTestServer(user.id, {
        tracearrServerId: "11111111-2222-3333-4444-555555555555",
        tracearrBackfillComplete: true,
      });
      const lib = await createTestLibrary(mapped.id, { type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "A", type: "MOVIE" });
      await prisma.library.update({ where: { id: lib.id }, data: { enabled: false } });
      const inFlight = snapshotWatchEvidence(mapped.id, new Date("2026-01-01T00:00:00Z"));

      setMockSession({ isLoggedIn: true, userId: user.id });
      const body = await expectJson<{ deleted: number }>(await purge({ libraryId: lib.id }), 200);
      expect(body.deleted).toBe(1);

      const row = await server(mapped.id);
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.tracearrBackfillComplete).toBe(true);
      expect(row.tracearrBackfillCursorAt).toBeNull();
      // The plays went with the items: a running pass cannot put the marker back, the next one can.
      expect(row.watchHistorySyncedAt).toBeNull();
      await expect(markWatchHistoryEstablishedIfUnchanged(inFlight)).resolves.toBe(false);
      await expect(
        markWatchHistoryEstablishedIfUnchanged(snapshotWatchEvidence(mapped.id, null)),
      ).resolves.toBe(true);
    });

    it("holds nothing when there is nothing to purge", async () => {
      const user = await createTestUser();
      const empty = await createTestServer(user.id);
      await createTestLibrary(empty.id, { type: "SERIES" });

      setMockSession({ isLoggedIn: true, userId: user.id });
      await expectJson(await purge({ type: "MOVIE" }), 200);

      const row = await server(empty.id);
      expect(row.libraryResyncRequiredAt).toBeNull();
      expect(row.watchHistorySyncedAt).not.toBeNull();
    });

    it("holds nothing for a library another user owns (404)", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const other = await createTestUser({ plexId: "other" });
      const owned = await createTestServer(owner.id);
      const lib = await createTestLibrary(owned.id, { type: "MOVIE" });
      await createTestMediaItem(lib.id, { title: "A", type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: other.id });
      await expectJson(await purge({ libraryId: lib.id }), 404);

      expect((await server(owned.id)).libraryResyncRequiredAt).toBeNull();
      expect(await prisma.mediaItem.count({ where: { libraryId: lib.id } })).toBe(1);
    });
  });
});
