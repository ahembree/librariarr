/**
 * A RUNNING `SyncJob` whose run died without recording its end must not block
 * the server until a restart.
 *
 * The run writes its own terminal status, but a database outage mid-sync fails
 * the catch's FAILED update too, and the row stayed RUNNING with nothing left
 * to end it: the sync task's "already running" guard skipped every later sync
 * of the server, the incremental sync and the watch-history task treated it as
 * a full sync in progress, the sync route answered 409 and Stop only flagged
 * it. Runs the real full sync, the real tasks and the real routes against the
 * real database; only the media server and the failing write are faked.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  createTestUser,
  createTestServer,
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
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn(async () => ({ count: 0 })) }));
vi.mock("@/lib/jobs/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/client")>()),
  enqueueJob: vi.fn(async () => true),
}));

const fake = vi.hoisted(() => ({
  getLibrariesError: null as unknown,
  onGetLibraries: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    testConnection: async () => ({ ok: true }),
    getLibraries: async () => {
      if (fake.onGetLibraries) await fake.onGetLibraries();
      if (fake.getLibrariesError) throw fake.getLibrariesError;
      return [];
    },
    getItemMetadata: async () => {
      throw new Error("not expected");
    },
  })),
}));

import { syncMediaServer } from "@/lib/sync/sync-server";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_SYNC_SERVER, TASK_SYNC_WATCH_HISTORY } from "@/lib/jobs/constants";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { beginSyncRun, endSyncRun, isSyncRunLive } from "@/lib/sync/live-sync-runs";
import { DEAD_SYNC_RUN_ERROR } from "@/lib/sync/cleanup-orphaned-syncs";
import { eventBus } from "@/lib/events/event-bus";
import { POST as syncRoute } from "@/app/api/servers/[id]/sync/route";
import { POST as cancelRoute } from "@/app/api/sync/cancel/route";

const prisma = getTestPrisma();
const helpers = {} as never;
const runTask = (task: string, payload: unknown) =>
  (taskList[task] as (p: unknown, h: unknown) => Promise<void>)(payload, helpers);

/**
 * Run a full sync that fails while the database is unreachable: the media
 * server errors, and the catch's FAILED update throws as well. Returns the row
 * it leaves RUNNING.
 */
async function strandRunningRow(serverId: string): Promise<string> {
  const original = prisma.$queryRawUnsafe.bind(prisma);
  const spy = vi.spyOn(prisma, "$queryRawUnsafe").mockImplementation((async (sql: string, ...values: unknown[]) => {
    if (sql.includes('UPDATE "SyncJob"') && values.includes("FAILED")) {
      throw new Error("Connection terminated unexpectedly");
    }
    return original(sql, ...values);
  }) as unknown as typeof prisma.$queryRawUnsafe);
  fake.getLibrariesError = new Error("ECONNRESET");
  try {
    await expect(syncMediaServer(serverId)).rejects.toThrow("Connection terminated unexpectedly");
  } finally {
    spy.mockRestore();
    fake.getLibrariesError = null;
  }
  const row = await prisma.syncJob.findFirstOrThrow({ where: { mediaServerId: serverId } });
  expect(row.status).toBe("RUNNING");
  return row.id;
}

async function seed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  return { user, server };
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  fake.getLibrariesError = null;
  fake.onGetLibraries = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("a RUNNING sync job whose run has died", () => {
  it("is live while its run is in progress", async () => {
    const { server } = await seed();
    let liveDuringRun: boolean | undefined;
    fake.onGetLibraries = async () => {
      const row = await prisma.syncJob.findFirstOrThrow({ where: { mediaServerId: server.id, status: "RUNNING" } });
      liveDuringRun = isSyncRunLive(row.id);
    };

    await syncMediaServer(server.id);

    expect(liveDuringRun).toBe(true);
    const row = await prisma.syncJob.findFirstOrThrow({ where: { mediaServerId: server.id } });
    expect(row.status).toBe("COMPLETED");
    expect(isSyncRunLive(row.id)).toBe(false);
  });

  it("is no longer live once its run ends, even when its terminal write failed", async () => {
    const { server } = await seed();
    const id = await strandRunningRow(server.id);
    expect(isSyncRunLive(id)).toBe(false);
  });

  it("is closed FAILED by the next sync of the server, which then runs", async () => {
    const { user, server } = await seed();
    const dead = await strandRunningRow(server.id);

    await runTask(TASK_SYNC_SERVER, { serverId: server.id, trigger: "scheduled sync" });

    const closed = await prisma.syncJob.findUniqueOrThrow({ where: { id: dead } });
    expect(closed.status).toBe("FAILED");
    expect(closed.error).toBe(DEAD_SYNC_RUN_ERROR);
    expect(closed.completedAt).not.toBeNull();
    // The sync it used to skip ran and recorded its own end.
    const others = await prisma.syncJob.findMany({ where: { mediaServerId: server.id, id: { not: dead } } });
    expect(others.map((row) => row.status)).toEqual(["COMPLETED"]);
    expect(eventBus.emit).toHaveBeenCalledWith({ type: "sync:failed", userId: user.id, meta: { serverId: server.id } });
  });

  it("still makes the sync task skip while the run is live", async () => {
    const { server } = await seed();
    const running = await prisma.syncJob.create({ data: { mediaServerId: server.id, status: "RUNNING" } });
    beginSyncRun(running.id);
    try {
      await runTask(TASK_SYNC_SERVER, { serverId: server.id, trigger: "scheduled sync" });
    } finally {
      endSyncRun(running.id);
    }
    expect((await prisma.syncJob.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING");
    expect(await prisma.syncJob.count({ where: { mediaServerId: server.id } })).toBe(1);
  });

  it("no longer makes the watch-history task skip", async () => {
    const { server } = await seed();
    const dead = await strandRunningRow(server.id);

    await runTask(TASK_SYNC_WATCH_HISTORY, { serverId: server.id });

    expect(syncWatchHistory).toHaveBeenCalledWith(server.id, undefined, undefined, { incremental: false });
    expect((await prisma.syncJob.findUniqueOrThrow({ where: { id: dead } })).status).toBe("FAILED");
  });

  it("no longer makes the incremental sync skip", async () => {
    const { server } = await seed();
    const dead = await strandRunningRow(server.id);

    const result = await syncMediaServerItems(server.id, [], []);

    expect(result.status).toBe("done");
    expect((await prisma.syncJob.findUniqueOrThrow({ where: { id: dead } })).status).toBe("FAILED");
  });

  it("no longer makes the sync route answer 409", async () => {
    const { user, server } = await seed();
    const dead = await strandRunningRow(server.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRouteWithParams(syncRoute, { id: server.id }, {
      url: `/api/servers/${server.id}/sync`,
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect((await prisma.syncJob.findUniqueOrThrow({ where: { id: dead } })).status).toBe("FAILED");
    expect(await prisma.syncJob.count({ where: { mediaServerId: server.id, status: "PENDING" } })).toBe(1);
  });

  it("is ended by Stop instead of only being flagged", async () => {
    const { user, server } = await seed();
    const dead = await strandRunningRow(server.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(cancelRoute, { url: "/api/sync/cancel", method: "POST", body: { serverId: server.id } });

    expect(response.status).toBe(200);
    expect((await prisma.syncJob.findUniqueOrThrow({ where: { id: dead } })).status).toBe("FAILED");
    expect(eventBus.emit).toHaveBeenCalledWith({ type: "sync:failed", userId: user.id, meta: { serverId: server.id } });
  });
});
