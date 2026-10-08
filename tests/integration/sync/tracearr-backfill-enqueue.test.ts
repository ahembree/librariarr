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
 * `enqueueTracearrBackfill` against the real graphile_worker schema: which
 * servers get a slice, replacing a parked one, and never throwing.
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
    // The `jobs` view has no payload, and a keyed add clears a running job's
    // key, so match on the payload to see both rows.
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
  let userId: string;
  let instanceId: string;
  let serverId: string;

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
    userId = (await createTestUser()).id;
    instanceId = (await enabledInstance(userId)).id;
    serverId = (await runnableServer(userId)).id;
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

  /** A slice already queued under the key, then put into the state `set` describes. */
  async function existingSlice(set: string) {
    await utils.addJob(TASK_TRACEARR_BACKFILL, { serverId }, {
      jobKey: tracearrBackfillJobKey(serverId),
      queueName: MAIN_QUEUE,
      maxAttempts: 3,
    });
    await pool.query(`UPDATE graphile_worker._private_jobs SET ${set} WHERE key = $1`, [
      tracearrBackfillJobKey(serverId),
    ]);
  }

  it("queues one slice under the shared key, on MAIN_QUEUE with three attempts", async () => {
    await expect(enqueueTracearrBackfill({ serverIds: [serverId] }, "test")).resolves.toEqual([serverId]);

    const [job] = await jobsFor(serverId);
    expect(job).toMatchObject({
      key: tracearrBackfillJobKey(serverId),
      task_identifier: TASK_TRACEARR_BACKFILL,
      queue_name: MAIN_QUEUE,
      attempts: 0,
      max_attempts: 3,
    });
    expect(tracearrBackfillJobKey(serverId)).toBe(`tracearr-backfill:${serverId}`);

    // Keyed: a second call collapses onto the same slice rather than stacking.
    await enqueueTracearrBackfill({ serverIds: [serverId] }, "again");
    expect(await jobsFor(serverId)).toHaveLength(1);
  });

  it("replaces a parked slice with a fresh one — the failing state it exists to clear", async () => {
    await existingSlice(`attempts = max_attempts, last_error = 'boom'`);

    await enqueueTracearrBackfill({ serverIds: [serverId] }, "instance re-enabled");

    // The one row the key names — what the status route reads — has every
    // attempt back.
    const keyed = (await jobsFor(serverId)).filter((j) => j.key !== null);
    expect(keyed).toHaveLength(1);
    expect(keyed[0].attempts).toBe(0);
    expect(keyed[0].max_attempts).toBe(3);
  });

  it("does not disturb a slice that is running — the fresh one queues behind it", async () => {
    await existingSlice(`attempts = 1, locked_at = now(), locked_by = 'w1'`);

    await enqueueTracearrBackfill({ serverIds: [serverId] }, "mapping changed");

    const jobs = await jobsFor(serverId);
    expect(jobs.filter((j) => j.locked_at !== null)).toHaveLength(1);
    const queued = jobs.filter((j) => j.locked_at === null);
    expect(queued).toHaveLength(1);
    expect(queued[0].key).toBe(tracearrBackfillJobKey(serverId));
  });

  it("queues every mapped, enabled, populated server of the account — and only those", async () => {
    const second = await runnableServer(userId);
    const disabled = await runnableServer(userId, { enabled: false });
    // Unmapped: native history, no import to run.
    const unmapped = await createTestServer(userId);
    await createTestMediaItem((await createTestLibrary(unmapped.id)).id);
    // Mapped but empty: the importer will not walk into an empty library.
    const empty = await createTestServer(userId, { tracearrServerId: "b0000000-0000-4000-8000-0000000000e1" });
    // Mapped, items only in a disabled library.
    const disabledLib = await createTestServer(userId, { tracearrServerId: "b0000000-0000-4000-8000-0000000000e2" });
    await createTestMediaItem((await createTestLibrary(disabledLib.id, { enabled: false })).id);
    const other = await createTestUser();
    await enabledInstance(other.id);
    const foreign = await runnableServer(other.id);

    const queued = await enqueueTracearrBackfill({ userId }, "instance added");

    expect(new Set(queued)).toEqual(new Set([serverId, second.id]));
    for (const id of [disabled.id, unmapped.id, empty.id, disabledLib.id, foreign.id]) {
      expect(await jobsFor(id)).toHaveLength(0);
    }
  });

  it("queues nothing without an enabled Tracearr instance — the slice could only fail", async () => {
    await getTestPrisma().tracearrInstance.update({ where: { id: instanceId }, data: { enabled: false } });

    await expect(enqueueTracearrBackfill({ serverIds: [serverId] }, "test")).resolves.toEqual([]);
    expect(await jobsFor(serverId)).toHaveLength(0);
  });

  it("never queues a walk held for a library resync ahead of the releasing sync", async () => {
    // Walked before the items exist again, their plays are skipped for good.
    await requireLibraryResync([serverId]);
    // Neither the restart nor a later cause-fixing save queues it...
    expect(await jobsFor(serverId)).toHaveLength(0);
    await expect(enqueueTracearrBackfill({ userId }, "instance re-enabled")).resolves.toEqual([]);
    // ...nor a walk having run since: only the release clears the hold.
    await getTestPrisma().mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillLastWalkAt: new Date() },
    });
    await expect(enqueueTracearrBackfill({ userId }, "instance re-enabled")).resolves.toEqual([]);

    await expect(releaseLibraryResyncHold(serverId, new Date())).resolves.toBe(true);
    await expect(enqueueTracearrBackfill({ userId }, "instance re-enabled")).resolves.toEqual([serverId]);
  });

  it("queues a first walk that failed after committing a page — it is not a restart", async () => {
    // A cursor and no walk stamp: the shape the hold used to be inferred from.
    await getTestPrisma().mediaServer.update({
      where: { id: serverId },
      data: { tracearrBackfillCursorAt: new Date(Date.UTC(2026, 8, 1)), tracearrBackfillLastWalkAt: null },
    });

    await expect(enqueueTracearrBackfill({ serverIds: [serverId] }, "instance re-enabled")).resolves.toEqual([
      serverId,
    ]);
    expect(await jobsFor(serverId)).toHaveLength(1);
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
    await pool.query("ALTER SCHEMA graphile_worker RENAME TO graphile_worker_hidden");
    try {
      await expect(enqueueTracearrBackfill({ serverIds: [serverId] }, "test")).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    } finally {
      await pool.query("ALTER SCHEMA graphile_worker_hidden RENAME TO graphile_worker");
    }
  });
});
