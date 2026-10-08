import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Pool } from "pg";
import { Logger, makeWorkerUtils, runOnce, type WorkerUtils } from "graphile-worker";

/**
 * The real {@link isJobRetrying} SQL, over jobs failed by graphile-worker
 * itself, so it reads exactly what a production failure leaves behind.
 */
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isJobRetrying, releaseJobsClient } from "@/lib/jobs/client";

const silent = new Logger(() => () => {});
const TASK = "always-fails";
const taskList = {
  [TASK]: async () => {
    throw new Error("still broken");
  },
};

let pool: Pool;
let utils: WorkerUtils;

async function failOnce(): Promise<void> {
  await runOnce({ pgPool: pool, taskList, logger: silent });
}

describe("isJobRetrying (real graphile_worker schema)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 4 });
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    utils = await makeWorkerUtils({ pgPool: pool, logger: silent });
    await utils.migrate();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM graphile_worker._private_jobs");
  });

  afterAll(async () => {
    await releaseJobsClient();
    if (utils) await Promise.resolve(utils.release()).catch(() => {});
    if (pool) {
      await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE").catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it("is false for a job that is queued but has never run", async () => {
    await utils.addJob(TASK, {}, { jobKey: "k", maxAttempts: 3 });
    await expect(isJobRetrying("k")).resolves.toBe(false);
    await expect(isJobRetrying("k", { failedWithinMs: 600_000 })).resolves.toBe(false);
  });

  it("is true for a job backing off after a failure with attempts left", async () => {
    await utils.addJob(TASK, {}, { jobKey: "k", maxAttempts: 3 });
    await failOnce();
    await expect(isJobRetrying("k")).resolves.toBe(true);
    // Why callers check first: a keyed enqueue resets the failed job's attempts.
    await utils.addJob(TASK, {}, { jobKey: "k", maxAttempts: 3 });
    await expect(isJobRetrying("k")).resolves.toBe(false);
  });

  it("treats a parked job as failed only within the cooldown it is asked about", async () => {
    await utils.addJob(TASK, {}, { jobKey: "k", maxAttempts: 1 });
    await failOnce();
    // Parked: a plain check lets the next enqueue give it a fresh start, a
    // cooldown holds off until the failure is that old.
    await expect(isJobRetrying("k")).resolves.toBe(false);
    await expect(isJobRetrying("k", { failedWithinMs: 600_000 })).resolves.toBe(true);

    await pool.query(
      `UPDATE graphile_worker._private_jobs SET run_at = now() - interval '1 hour'`,
    );
    await expect(isJobRetrying("k", { failedWithinMs: 600_000 })).resolves.toBe(false);
  });

  it("is false for a key nothing is queued under", async () => {
    await utils.addJob(TASK, {}, { jobKey: "other", maxAttempts: 3 });
    await failOnce();
    await expect(isJobRetrying("k", { failedWithinMs: 600_000 })).resolves.toBe(false);
  });

  it("survives a release, idempotent or not, by opening a fresh pool", async () => {
    await releaseJobsClient();
    await releaseJobsClient();
    await expect(isJobRetrying("k")).resolves.toBe(false);
  });
});
