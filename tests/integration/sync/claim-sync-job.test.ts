/**
 * Which `SyncJob` row a full sync reports into (`claimSyncJob`), against the
 * real database.
 *
 * A run without a usable `syncJobId` used to adopt any unclaimed PENDING row of
 * the server — meant for a queued run whose payload lost its id to a jobKey
 * collision, but reached by every caller: the post-delete re-check's inline
 * library sync took the user's Settings Sync row (or a library page's), marked
 * it COMPLETED, and that request read as settled before its own job ran; a
 * retry of a FAILED requested row took the next library job's row, shifting
 * every job of a library-page Sync onto another's row.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer, createTestLibrary } from "../../setup/test-helpers";

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
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    testConnection: async () => ({ ok: true }),
    getLibraries: async () => [],
    getItemMetadata: async () => {
      throw new Error("not expected");
    },
  })),
}));

import { syncMediaServer } from "@/lib/sync/sync-server";
import { taskList } from "@/lib/jobs/tasks";
import { TASK_SYNC_SERVER } from "@/lib/jobs/constants";
import { POST_DELETE_SYNC_TRIGGER } from "@/lib/lifecycle/post-delete-resync";

const prisma = getTestPrisma();

async function seed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  return server;
}

/** A row another request created and its still-queued job will claim. */
function pendingRow(serverId: string, startedAt = new Date(Date.now() - 60_000)) {
  return prisma.syncJob.create({ data: { mediaServerId: serverId, status: "PENDING", startedAt } });
}

const status = async (id: string) => (await prisma.syncJob.findUniqueOrThrow({ where: { id } })).status;

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("claimSyncJob", () => {
  it("leaves another request's PENDING row alone for an inline sync", async () => {
    const server = await seed();
    const requested = await pendingRow(server.id);

    // As `PostDeleteResync` calls it.
    await syncMediaServer(server.id, "1", { trigger: POST_DELETE_SYNC_TRIGGER, skipWatchHistory: true });

    expect(await status(requested.id)).toBe("PENDING");
    const own = await prisma.syncJob.findMany({ where: { mediaServerId: server.id, id: { not: requested.id } } });
    expect(own.map((row) => row.status)).toEqual(["COMPLETED"]);
  });

  it("gives a retry of a FAILED requested row a fresh row even when another is unclaimed", async () => {
    const server = await seed();
    const failed = await prisma.syncJob.create({
      data: { mediaServerId: server.id, status: "FAILED", completedAt: new Date(), error: "ECONNRESET" },
    });
    const otherLibrary = await pendingRow(server.id);

    await syncMediaServer(server.id, "1", { syncJobId: failed.id, skipWatchHistory: true });

    expect(await status(failed.id)).toBe("FAILED");
    expect(await status(otherLibrary.id)).toBe("PENDING");
    const fresh = await prisma.syncJob.findMany({
      where: { mediaServerId: server.id, id: { notIn: [failed.id, otherLibrary.id] } },
    });
    expect(fresh.map((row) => row.status)).toEqual(["COMPLETED"]);
  });

  it("still lets a queued run whose payload lost its id adopt the row it was waiting for", async () => {
    const server = await seed();
    const requested = await pendingRow(server.id);

    // The dispatcher's `sync:<id>` enqueue replaced the Settings Sync's payload.
    await (taskList[TASK_SYNC_SERVER] as (p: unknown, h: unknown) => Promise<void>)(
      { serverId: server.id, trigger: "scheduled sync" },
      {} as never,
    );

    expect(await status(requested.id)).toBe("COMPLETED");
    expect(await prisma.syncJob.count({ where: { mediaServerId: server.id } })).toBe(1);
  });
});
