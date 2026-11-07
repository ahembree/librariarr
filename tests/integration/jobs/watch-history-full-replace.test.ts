import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { makeWorkerUtils } from "graphile-worker";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser, createTestServer, createTestLibrary } from "../../setup/test-helpers";

/**
 * `/api/sync/by-type` and the realtime manager queue `TASK_SYNC_WATCH_HISTORY`
 * under the same jobKey, `watch-history:<serverId>`: by-type's is the full
 * replace that reconciles the plays a server has since deleted, the realtime
 * manager's an incremental append after a finished playback. A keyed `addJob`
 * replaces the payload of a job still queued under the key, so the realtime
 * enqueue used to turn the full replace into an append. Runs the real route and
 * the real `enqueueJob` against a real graphile_worker schema.
 */
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));

import { POST } from "@/app/api/sync/by-type/route";
import { enqueueJob, releaseJobsClient } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_SYNC_WATCH_HISTORY } from "@/lib/jobs/constants";

let pool: Pool;

/** The payload of the job still waiting under `jobKey`, or null. */
async function queuedPayload(jobKey: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT "payload" FROM graphile_worker._private_jobs WHERE "key" = $1 AND "locked_at" IS NULL`,
    [jobKey],
  );
  return rows[0]?.payload ?? null;
}

/** The realtime manager's enqueue after a finished playback (`manager.ts`). */
function enqueueRealtimeRefresh(serverId: string) {
  return enqueueJob(
    TASK_SYNC_WATCH_HISTORY,
    { serverId, incremental: true },
    { jobKey: `watch-history:${serverId}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
  );
}

describe("watch-history refresh enqueues sharing one jobKey (real graphile_worker schema)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    const utils = await makeWorkerUtils({ pgPool: pool });
    await utils.migrate();
    await Promise.resolve(utils.release()).catch(() => {});
  });

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    await pool.query("DELETE FROM graphile_worker._private_jobs");
  });

  afterAll(async () => {
    await releaseJobsClient();
    if (pool) {
      await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE").catch(() => {});
      await pool.end().catch(() => {});
    }
    await disconnectTestDb();
  });

  it("keeps by-type's queued full replace when a play finishes before it runs", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/sync/by-type",
      method: "POST",
      body: { libraryType: "MOVIE" },
    });
    expect(response.status).toBe(200);
    const jobKey = `watch-history:${server.id}`;
    expect(await queuedPayload(jobKey)).toEqual({ serverId: server.id });

    await expect(enqueueRealtimeRefresh(server.id)).resolves.toBe(true);

    const payload = await queuedPayload(jobKey);
    expect(payload).toEqual({ serverId: server.id });
    expect(payload?.incremental).toBeUndefined();
  });

  it("still turns a queued incremental refresh into by-type's full replace", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "m1", type: "MOVIE" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    await enqueueRealtimeRefresh(server.id);
    const jobKey = `watch-history:${server.id}`;
    expect(await queuedPayload(jobKey)).toEqual({ serverId: server.id, incremental: true });

    await callRoute(POST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } });
    expect(await queuedPayload(jobKey)).toEqual({ serverId: server.id });
  });

  it("stays incremental when only realtime refreshes are queued", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    await enqueueRealtimeRefresh(server.id);
    await enqueueRealtimeRefresh(server.id);
    expect(await queuedPayload(`watch-history:${server.id}`)).toEqual({ serverId: server.id, incremental: true });
  });

  it("queues an incremental refresh beside a full replace that is already running", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const jobKey = `watch-history:${server.id}`;

    await enqueueJob(TASK_SYNC_WATCH_HISTORY, { serverId: server.id }, { jobKey, queueName: MAIN_QUEUE, maxAttempts: 3 });
    // The worker picked the full replace up.
    await pool.query(
      `UPDATE graphile_worker._private_jobs SET "locked_at" = now(), "locked_by" = 'test-worker' WHERE "key" = $1`,
      [jobKey],
    );

    await enqueueRealtimeRefresh(server.id);
    expect(await queuedPayload(jobKey)).toEqual({ serverId: server.id, incremental: true });
  });
});
