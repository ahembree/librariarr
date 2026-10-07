import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { Logger, makeWorkerUtils, type WorkerUtils } from "graphile-worker";
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

/**
 * Two states the Tracearr status readout got wrong, through the real route,
 * the real importer and graphile-worker's real job table (so `pending` is
 * judged on the queue, as in production):
 *
 *  - a run superseded by a restart or a mapping change was still reported as
 *    the live import — `pending`, with its counts — against the new mapping;
 *  - a restarted walk on a mapping Tracearr holds no plays for read "starts
 *    after the next full sync" forever, because the restart's cursor was taken
 *    as a sign the mapping has history.
 */

const TRACEARR_SERVER_ID = "c0000000-0000-4000-8000-000000000001";

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

import { GET } from "@/app/api/integrations/tracearr/status/route";
import { importAwaitingSync } from "@/app/api/integrations/tracearr/status/backfill-fraction";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import {
  beginTracearrImport,
  endTracearrImport,
  recordTracearrImportPage,
  retireTracearrImports,
} from "@/lib/sync/tracearr-import-activity";
import {
  releaseLibraryResyncHold,
  requireLibraryResync,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";
import { releaseJobsClient } from "@/lib/jobs/client";

interface StatusRow {
  serverId: string;
  backfillComplete: boolean;
  importedCount: number;
  pending: boolean;
  pausedReason: string | null;
  lastWalkAt: string | null;
  activeImport: {
    pass: string | null;
    pages: number;
    imported: number;
    backfillReached: string | null;
  } | null;
}

const prisma = getTestPrisma();
const silent = new Logger(() => () => {});
let pool: Pool;
let utils: WorkerUtils;
let userId: string;
let serverId: string;

const read = async (): Promise<StatusRow> =>
  (await expectJson<{ servers: StatusRow[] }>(
    await callRoute(GET, { url: "/api/integrations/tracearr/status" }),
  )).servers[0];

const queueBackfill = () =>
  utils.addJob("tracearr-backfill", { serverId }, { jobKey: `tracearr-backfill:${serverId}`, maxAttempts: 3 });

const record = (id: string, startedAt: string, ratingKey = "100") => ({
  id,
  reference_id: id,
  server_id: TRACEARR_SERVER_ID,
  media_type: "movie",
  rating_key: ratingKey,
  started_at: startedAt,
  stopped_at: startedAt,
  state: "stopped",
  watched: true,
  user: { id: "u", server_user_id: "acct-1", username: "Walter W" },
});

describe("Tracearr status: superseded runs and restarted empty walks (real DB, real job table)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    utils = await makeWorkerUtils({ pgPool: pool, logger: silent });
    await utils.migrate();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await pool.query("DELETE FROM graphile_worker._private_jobs");
    clearMockSession();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.findOldestPlayAt.mockResolvedValue(null);
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { name: "Plex", tracearrServerId: TRACEARR_SERVER_ID });
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
    await prisma.tracearrInstance.create({
      data: { userId, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    setMockSession({ userId, plexToken: "tok", isLoggedIn: true });
  });

  afterAll(async () => {
    await releaseJobsClient();
    if (utils) await Promise.resolve(utils.release()).catch(() => {});
    if (pool) {
      await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE").catch(() => {});
      await pool.end().catch(() => {});
    }
    await disconnectTestDb();
  });

  describe("a run retired by a mapping change", () => {
    it("is not reported as live, so whether the import is pending follows the job table", async () => {
      const run = beginTracearrImport(serverId, userId);
      try {
        recordTracearrImportPage(run, { pass: "backfill", pages: 40, imported: 3900, oldestReached: null });
        const live = await read();
        expect(live.activeImport).toMatchObject({ pages: 40, imported: 3900 });
        expect(live.pending).toBe(true);

        retireTracearrImports(serverId);

        const superseded = await read();
        expect(superseded.activeImport).toBeNull();
        // Nothing queued for the import that replaced it: owed, waiting on a
        // sync — not "importing" on the strength of a run of the old archive.
        expect(superseded.pending).toBe(false);
        expect(superseded.pausedReason).toBe("awaiting-sync");

        await queueBackfill();
        expect((await read()).pending).toBe(true);
      } finally {
        endTracearrImport(run);
      }
    });

    it("reports a run begun after it, and its own end changes nothing", async () => {
      const old = beginTracearrImport(serverId, userId);
      const fresh = (() => {
        retireTracearrImports(serverId);
        return beginTracearrImport(serverId, userId);
      })();
      try {
        recordTracearrImportPage(old, { pass: "backfill", pages: 300, imported: 29000, oldestReached: null });
        recordTracearrImportPage(fresh, { pass: "forward", pages: 1, imported: 4, oldestReached: null });
        expect((await read()).activeImport).toMatchObject({ pass: "forward", pages: 1, imported: 4 });

        endTracearrImport(old);
        const row = await read();
        expect(row.activeImport).toMatchObject({ pass: "forward", pages: 1, imported: 4 });
        expect(row.pending).toBe(true);
      } finally {
        endTracearrImport(old);
        endTracearrImport(fresh);
      }
    });

  });

  describe("a run whose walk a restart superseded", () => {
    it("stays on the readout, so a Refresh importing through a restore does not read as failing beside a parked slice", async () => {
      // The slice failed every attempt and is parked.
      await queueBackfill();
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET attempts = max_attempts WHERE key = $1`,
        [`tracearr-backfill:${serverId}`],
      );
      const refresh = beginTracearrImport(serverId, userId);
      try {
        recordTracearrImportPage(refresh, { pass: "forward", pages: 2, imported: 120, oldestReached: null });
        expect((await read()).pausedReason).toBeNull();

        // A restore whose media came back restarts the walk directly — no
        // hold. The Refresh's plays are still this server's.
        await restartTracearrBackfill([serverId]);

        const during = await read();
        expect(during.activeImport).toMatchObject({ pass: "forward", pages: 2, imported: 120 });
        expect(during.pausedReason).toBeNull();
        expect(during.pending).toBe(true);
      } finally {
        endTracearrImport(refresh);
      }
      // Once it ends, the parked slice is all that is left.
      expect((await read()).pausedReason).toBe("import-failing");
    });

    it("keeps a slice the restart superseded mid-walk on the readout, without the reach it had", async () => {
      // The real importer: a backfill slice is mid-walk when a purge restarts
      // it. Its deep reach no longer describes the walk; the slice itself is
      // still running until its next (refused) state write.
      let duringRun: StatusRow | undefined;
      m.getHistoryPage
        .mockImplementationOnce(async () => ({
          records: [record("p1", "2026-01-02T00:00:00.000Z")],
          nextCursor: "c2",
        }))
        .mockImplementationOnce(async () => {
          expect((await read()).activeImport).toMatchObject({
            pass: "backfill",
            pages: 1,
            backfillReached: "2026-01-02T00:00:00.000Z",
          });
          await requireLibraryResync([serverId]);
          duringRun = await read();
          return { records: [record("p2", "2026-01-01T00:00:00.000Z")], nextCursor: null };
        });

      await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(duringRun?.activeImport).toMatchObject({ pass: "backfill", pages: 1, backfillReached: null });
      // Held until the library sync that brings the purged items back.
      expect(duringRun?.pausedReason).toBe("awaiting-sync");
      expect(duringRun?.pending).toBe(false);
    });
  });

  describe("a restarted walk on a mapping Tracearr holds no plays for", () => {
    it("reads walked-and-empty, not 'starts after the next full sync', once the released walk finds nothing", async () => {
      // A purge (or a library populated for the first time) holds the server
      // and restarts the walk: the cursor moves to the restart instant.
      await requireLibraryResync([serverId]);
      const held = await read();
      expect(held.pausedReason).toBe("awaiting-sync");
      expect(held.pending).toBe(false);

      // The full sync that brings the items back releases it.
      expect(await releaseLibraryResyncHold(serverId, new Date())).toBe(true);

      // The walk it queues finds nothing at all: exhausted and empty. The
      // cursor stays where the restart put it.
      m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
      const walk = await syncTracearrHistory(serverId, { passes: "backfill" });
      expect(walk).toMatchObject({ backfillOutcome: "exhausted", backfillPending: true });
      expect(walk.heldReason).toBeUndefined();
      const stored = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
      expect(stored.tracearrBackfillCursorAt).not.toBeNull();
      expect(stored.tracearrBackfillLastWalkAt).toBeInstanceOf(Date);

      // Nothing queued (the task does not re-queue an empty answer): this is
      // the "no plays imported" end state, not a wait for a sync that already
      // ran — and, with nothing that will ever progress, not pending either.
      const row = await read();
      expect(row.lastWalkAt).not.toBeNull();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(false);

      // A slice queued later (the next watch-history sync) reads as pending.
      await queueBackfill();
      expect((await read()).pending).toBe(true);
    });

    it("reads the same after a restore restarted the walk without a hold", async () => {
      // A restore whose file lacked the server's Tracearr rows restarts the
      // walk but holds nothing (the items came back with the file).
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillLastWalkAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      await restartTracearrBackfill([serverId]);
      m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });

      await syncTracearrHistory(serverId, { passes: "backfill" });

      const row = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(false);
    });

    it("still completes, as before, when the walk sees plays it cannot store", async () => {
      await requireLibraryResync([serverId]);
      await releaseLibraryResyncHold(serverId, new Date());
      m.getHistoryPage.mockResolvedValue({
        records: [record("gone", "2025-01-01T00:00:00.000Z", "missing")],
        nextCursor: null,
      });

      const walk = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(walk).toMatchObject({ backfillOutcome: "exhausted", backfillPending: false });
      const row = await read();
      expect(row.backfillComplete).toBe(true);
      expect(row.importedCount).toBe(0);
      expect(row.pending).toBe(false);
      expect(row.pausedReason).toBeNull();
    });

    it("keeps reading the hold first while it is set, walked-and-empty or not", async () => {
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillLastWalkAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      await requireLibraryResync([serverId]);
      // The walk stamp a restart clears is put back: walked, empty, cursor set.
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillLastWalkAt: new Date() },
      });

      const row = await read();
      expect(row.pausedReason).toBe("awaiting-sync");
      expect(row.pending).toBe(false);
    });
  });
});

describe("importAwaitingSync: the cursor is not evidence of history", () => {
  const walkedEmpty = {
    backfillComplete: false,
    importedCount: 0,
    oldestPlayAt: null,
    lastWalkAt: new Date(),
    running: false,
    queued: false,
    parked: false,
    jobsKnown: true,
  } as const;

  it("leaves a walked-and-empty mapping alone whether or not a restart left a cursor", () => {
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: null })).toBe(false);
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: new Date() })).toBe(false);
  });

  it("still waits on a sync when the walk has history to show — rows or a measured far edge", () => {
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: new Date(), importedCount: 3 })).toBe(true);
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: new Date(), oldestPlayAt: new Date(0) })).toBe(true);
  });

  it("puts the hold first", () => {
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: new Date(), resyncRequiredAt: new Date() })).toBe(true);
  });
});
