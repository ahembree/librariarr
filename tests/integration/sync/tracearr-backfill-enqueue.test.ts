import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Pool } from "pg";
import { Logger, makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * `enqueueTracearrBackfill` against the REAL graphile_worker schema and the
 * real `enqueueJob`: which servers it queues a slice for, that the slice
 * replaces a parked one (the "History import failing" state it exists to
 * clear), and that it never throws.
 */

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger,
  apiLogger: logger,
  dbLogger: logger,
}));

import {
  enqueueTracearrBackfill,
  tracearrBackfillJobKey,
} from "@/lib/sync/tracearr-backfill-enqueue";
import { releaseLibraryResyncHold, requireLibraryResync } from "@/lib/media/watch-evidence";
import { releaseJobsClient } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_TRACEARR_BACKFILL } from "@/lib/jobs/constants";
import { prisma as appPrisma } from "@/lib/db";

const silent = new Logger(() => () => {});
let pool: Pool;
let utils: WorkerUtils;

interface JobRow {
  key: string;
  task_identifier: string;
  queue_name: string | null;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  payload: { serverId: string };
}

async function jobsFor(serverId: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    // The `jobs` view has no payload; a running job's key is cleared by a
    // keyed add, so match on the payload to see both rows.
    `SELECT v."key", v."task_identifier", v."queue_name", v."attempts", v."max_attempts", v."locked_at", j."payload"
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker.jobs v ON v."id" = j."id"
      WHERE j."payload"->>'serverId' = $1`,
    [serverId],
  );
  return rows;
}

let tracearrSeq = 0;
/** A mapped, enabled server with one item in an enabled library — runnable. */
async function runnableServer(userId: string, overrides: { enabled?: boolean } = {}) {
  const server = await createTestServer(userId, {
    enabled: overrides.enabled ?? true,
    tracearrServerId: `b0000000-0000-4000-8000-${String(++tracearrSeq).padStart(12, "0")}`,
  });
  const library = await createTestLibrary(server.id);
  await createTestMediaItem(library.id);
  return server;
}

async function enabledInstance(userId: string, enabled = true) {
  return getTestPrisma().tracearrInstance.create({
    data: { userId, name: "Tracearr", url: "http://tracearr.test", apiKey: "key", enabled },
  });
}

describe("enqueueTracearrBackfill (real graphile_worker schema)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    utils = await makeWorkerUtils({ pgPool: pool, logger: silent });
    await utils.migrate();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await pool.query("DELETE FROM graphile_worker._private_jobs");
    vi.clearAllMocks();
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

  it("queues one slice under the shared key, on MAIN_QUEUE with three attempts", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);

    await expect(enqueueTracearrBackfill({ serverIds: [server.id] }, "test")).resolves.toEqual([server.id]);

    const [job] = await jobsFor(server.id);
    expect(job).toMatchObject({
      key: tracearrBackfillJobKey(server.id),
      task_identifier: TASK_TRACEARR_BACKFILL,
      queue_name: MAIN_QUEUE,
      attempts: 0,
      max_attempts: 3,
    });
    expect(tracearrBackfillJobKey(server.id)).toBe(`tracearr-backfill:${server.id}`);

    // Keyed: a second call collapses onto the same slice rather than stacking.
    await enqueueTracearrBackfill({ serverIds: [server.id] }, "again");
    expect(await jobsFor(server.id)).toHaveLength(1);
  });

  it("replaces a parked slice with a fresh one — the failing state it exists to clear", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    await utils.addJob(TASK_TRACEARR_BACKFILL, { serverId: server.id }, {
      jobKey: tracearrBackfillJobKey(server.id),
      queueName: MAIN_QUEUE,
      maxAttempts: 3,
    });
    await pool.query(
      `UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'boom' WHERE key = $1`,
      [tracearrBackfillJobKey(server.id)],
    );

    await enqueueTracearrBackfill({ serverIds: [server.id] }, "instance re-enabled");

    // graphile clears the parked row's key and inserts a fresh job under it, so
    // the one row the key names — what the status route reads — has every
    // attempt back.
    const keyed = (await jobsFor(server.id)).filter((j) => j.key !== null);
    expect(keyed).toHaveLength(1);
    expect(keyed[0].attempts).toBe(0);
    expect(keyed[0].max_attempts).toBe(3);
  });

  it("does not disturb a slice that is running — the fresh one queues behind it", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    await utils.addJob(TASK_TRACEARR_BACKFILL, { serverId: server.id }, {
      jobKey: tracearrBackfillJobKey(server.id),
      queueName: MAIN_QUEUE,
      maxAttempts: 3,
    });
    await pool.query(
      `UPDATE graphile_worker._private_jobs SET attempts = 1, locked_at = now(), locked_by = 'w1' WHERE key = $1`,
      [tracearrBackfillJobKey(server.id)],
    );

    await enqueueTracearrBackfill({ serverIds: [server.id] }, "mapping changed");

    const jobs = await jobsFor(server.id);
    // graphile clears the running job's key and inserts a new one under it.
    expect(jobs.filter((j) => j.locked_at !== null)).toHaveLength(1);
    const queued = jobs.filter((j) => j.locked_at === null);
    expect(queued).toHaveLength(1);
    expect(queued[0].key).toBe(tracearrBackfillJobKey(server.id));
  });

  it("queues every mapped, enabled, populated server of the account — and only those", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const runnable = await runnableServer(user.id);
    const second = await runnableServer(user.id);
    const disabled = await runnableServer(user.id, { enabled: false });
    // Unmapped: native history, no import to run.
    const unmapped = await createTestServer(user.id);
    await createTestMediaItem((await createTestLibrary(unmapped.id)).id);
    // Mapped but empty: the importer refuses to walk into an empty library, and
    // the first sync queues the slice itself.
    const empty = await createTestServer(user.id, { tracearrServerId: "b0000000-0000-4000-8000-0000000000e1" });
    // Mapped, items only in a disabled library — empty as far as the walk goes.
    const disabledLib = await createTestServer(user.id, { tracearrServerId: "b0000000-0000-4000-8000-0000000000e2" });
    await createTestMediaItem((await createTestLibrary(disabledLib.id, { enabled: false })).id);
    // Another account's server.
    const other = await createTestUser();
    await enabledInstance(other.id);
    const foreign = await runnableServer(other.id);

    const queued = await enqueueTracearrBackfill({ userId: user.id }, "instance added");

    expect(new Set(queued)).toEqual(new Set([runnable.id, second.id]));
    for (const id of [disabled.id, unmapped.id, empty.id, disabledLib.id, foreign.id]) {
      expect(await jobsFor(id)).toHaveLength(0);
    }
  });

  it("queues nothing without an enabled Tracearr instance — the slice could only fail", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id, false);
    const server = await runnableServer(user.id);

    await expect(enqueueTracearrBackfill({ serverIds: [server.id] }, "test")).resolves.toEqual([]);
    expect(await jobsFor(server.id)).toHaveLength(0);
  });

  it("never queues a walk restarted by a purge or restore ahead of the re-sync", async () => {
    // The purged items' plays are what the restarted walk exists to bring back.
    // Walked before a sync re-creates the items, those plays are skipped as
    // unresolved and the walk can mark the archive complete without them.
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillLastWalkAt: new Date(Date.UTC(2026, 0, 1)) },
    });

    // What a purge records before deleting (it also restarts the walk).
    await requireLibraryResync([server.id]);
    // The restart itself queues nothing...
    expect(await jobsFor(server.id)).toHaveLength(0);
    // ...and nor does a later cause-fixing save.
    await expect(enqueueTracearrBackfill({ userId: user.id }, "instance re-enabled")).resolves.toEqual([]);
    expect(await jobsFor(server.id)).toHaveLength(0);
    // Nor does a walk merely having run: only the release clears the hold.
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillLastWalkAt: new Date() },
    });
    await expect(enqueueTracearrBackfill({ userId: user.id }, "instance re-enabled")).resolves.toEqual([]);

    // Once a full sync has released the hold, it is an ordinary mapping and
    // is queued as before.
    await expect(releaseLibraryResyncHold(server.id, new Date())).resolves.toBe(true);
    await expect(enqueueTracearrBackfill({ userId: user.id }, "instance re-enabled")).resolves.toEqual([server.id]);
  });

  it("queues a first walk that failed after committing a page — it is not a restart", async () => {
    // A cursor and no walk stamp: the shape the restart hold used to be
    // inferred from. Refused, the slice sat unqueued waiting on a full sync
    // that, with the sync schedule off, never came.
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: {
        tracearrBackfillCursorAt: new Date(Date.UTC(2026, 8, 1)),
        tracearrBackfillLastWalkAt: null,
        libraryResyncRequiredAt: null,
      },
    });

    await expect(enqueueTracearrBackfill({ serverIds: [server.id] }, "instance re-enabled")).resolves.toEqual([
      server.id,
    ]);
    expect(await jobsFor(server.id)).toHaveLength(1);
  });

  it("queues a fresh mapping whose walk state is all reset", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    // What the server PUT writes on a mapping change.
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillCursorAt: null, tracearrBackfillLastWalkAt: null },
    });

    await expect(enqueueTracearrBackfill({ serverIds: [server.id] }, "mapping set")).resolves.toEqual([server.id]);
  });

  it("does nothing for an empty id list", async () => {
    const spy = vi.spyOn(appPrisma.mediaServer, "findMany");
    await expect(enqueueTracearrBackfill({ serverIds: [] }, "test")).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws: a failed read is logged and queues nothing", async () => {
    const spy = vi.spyOn(appPrisma.mediaServer, "findMany").mockRejectedValueOnce(new Error("db down"));
    await expect(enqueueTracearrBackfill({ userId: "u" }, "test")).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws: a failed enqueue is logged and reported as not queued", async () => {
    const user = await createTestUser();
    await enabledInstance(user.id);
    const server = await runnableServer(user.id);
    await pool.query("ALTER SCHEMA graphile_worker RENAME TO graphile_worker_hidden");
    try {
      await expect(enqueueTracearrBackfill({ serverIds: [server.id] }, "test")).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    } finally {
      await pool.query("ALTER SCHEMA graphile_worker_hidden RENAME TO graphile_worker");
    }
  });
});
