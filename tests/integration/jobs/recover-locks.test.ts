import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";

/**
 * Exercises the REAL {@link recoverOrphanedWorkerLocks} against a REAL
 * graphile_worker schema on the test database — the path the unit test (which
 * mocks the pg pool) can't cover. This is what proves the actual SQL works, and
 * it doubles as a guard: if a graphile-worker upgrade renames the internal
 * `_private_*` tables, this test fails loudly instead of the recovery silently
 * regressing to graphile's 4-hour stale-lock window.
 *
 * graphile-worker is only partially mocked so `recoverOrphanedWorkerLocks` uses
 * the genuine `runMigrations`; `run`/`parseCrontab` are stubbed only so that
 * importing `@/lib/jobs/worker` never spins up an actual runner. The heavy task
 * graph and logger are stubbed to keep the import light.
 */
vi.mock("graphile-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("graphile-worker")>();
  return { ...actual, run: vi.fn(), parseCrontab: vi.fn(() => []) };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/jobs/tasks", () => ({ taskList: {} }));
vi.mock("@/lib/jobs/client", () => ({ getJobsPool: vi.fn() }));

import { recoverOrphanedWorkerLocks } from "@/lib/jobs/worker";

const MAIN_QUEUE = "librariarr:main";

let pool: Pool;
let utils: WorkerUtils;

describe("recoverOrphanedWorkerLocks (real graphile_worker schema)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 4 });
    // Clean slate so a leftover schema from a prior run can't mask a regression.
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    // First call creates the schema via the real runMigrations and no-ops the
    // UPDATEs against empty tables — proves it survives a first-ever boot.
    await recoverOrphanedWorkerLocks(pool);
    utils = await makeWorkerUtils({ pgPool: pool });
  });

  afterAll(async () => {
    // release() returns graphile-worker's PromiseOrDirect<void>; wrap so .catch
    // is always valid (mirrors releaseJobsClient in src/lib/jobs/client.ts).
    if (utils) await Promise.resolve(utils.release()).catch(() => {});
    if (pool) {
      await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE").catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it("created the graphile_worker schema and its internal lock tables", async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'graphile_worker'
          and c.relname in ('_private_jobs', '_private_job_queues')`,
    );
    const names = rows.map((r) => r.relname).sort();
    expect(names).toEqual(["_private_job_queues", "_private_jobs"]);
  });

  it("clears a queue + job lock left by a crashed worker", async () => {
    // Enqueue a MAIN_QUEUE job, then forge the exact on-disk state a hard kill
    // leaves behind: the queue row and the job row locked by a dead worker.
    await utils.addJob("noop", { n: 1 }, { queueName: MAIN_QUEUE, jobKey: "stuck", maxAttempts: 3 });
    await pool.query(
      `update graphile_worker._private_job_queues
          set locked_at = now() - interval '1 minute', locked_by = 'dead-worker-abcdef0123'
        where queue_name = $1`,
      [MAIN_QUEUE],
    );
    await pool.query(
      `update graphile_worker._private_jobs
          set locked_at = now() - interval '1 minute', locked_by = 'dead-worker-abcdef0123'
        where key = 'stuck'`,
    );

    // Sanity: the locks are really set (otherwise the assertion below is vacuous).
    const before = await pool.query<{ qlocked: number; jlocked: number }>(
      `select
         (select count(*) from graphile_worker._private_job_queues where locked_at is not null)::int as qlocked,
         (select count(*) from graphile_worker._private_jobs where locked_at is not null)::int as jlocked`,
    );
    expect(before.rows[0].qlocked).toBe(1);
    expect(before.rows[0].jlocked).toBe(1);

    await recoverOrphanedWorkerLocks(pool);

    const after = await pool.query<{
      qlocked: number;
      jlocked: number;
      qby: number;
      jby: number;
    }>(
      `select
         (select count(*) from graphile_worker._private_job_queues where locked_at is not null)::int as qlocked,
         (select count(*) from graphile_worker._private_jobs where locked_at is not null)::int as jlocked,
         (select count(*) from graphile_worker._private_job_queues where locked_by is not null)::int as qby,
         (select count(*) from graphile_worker._private_jobs where locked_by is not null)::int as jby`,
    );
    // Both lock columns cleared on both tables, so the queue is available again
    // and the orphaned job is runnable.
    expect(after.rows[0].qlocked).toBe(0);
    expect(after.rows[0].jlocked).toBe(0);
    expect(after.rows[0].qby).toBe(0);
    expect(after.rows[0].jby).toBe(0);

    // The job itself still exists (we recover it, not delete it).
    const { rows } = await pool.query<{ c: number }>(
      `select count(*)::int as c from graphile_worker._private_jobs where key = 'stuck'`,
    );
    expect(rows[0].c).toBe(1);
  });

  it("is idempotent when there is nothing to recover", async () => {
    await expect(recoverOrphanedWorkerLocks(pool)).resolves.toBeUndefined();
  });
});
