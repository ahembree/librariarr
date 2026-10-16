/**
 * A library-page Sync over several libraries, run through the real route, the
 * real sync engine and the real Stop. Its library jobs used to share one row:
 * the first job claimed and completed it, so between libraries the server
 * showed no active sync — the Sync button stopped spinning with libraries
 * still queued — and a Stop pressed after the first library could not reach
 * the ones queued behind it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn(async () => ({ count: 0 })) }));

const state = vi.hoisted(() => ({
  onSection: null as null | ((key: string) => Promise<void>),
  enqueued: [] as Array<{ identifier: string; payload: Record<string, unknown> }>,
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: vi.fn(async (identifier: string, payload: Record<string, unknown>) => {
    state.enqueued.push({ identifier, payload });
    return true;
  }),
  queuedSyncJobIds: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    bulkListingIncomplete: false,
    testConnection: vi.fn(async () => ({ ok: true })),
    getLibraries: vi.fn(async () => [
      { key: "1", title: "Movies A", type: "movie" },
      { key: "2", title: "Movies B", type: "movie" },
      { key: "3", title: "Movies C", type: "movie" },
    ]),
    getWatchCounts: vi.fn(async () => new Map()),
    getLibraryItemsPage: vi.fn(async (section: string, _type: string, offset: number) => {
      if (offset === 0 && state.onSection) await state.onSection(section);
      const items = offset === 0
        ? [{ ratingKey: `m${section}`, key: `/library/metadata/m${section}`, type: "movie", title: `Movie ${section}`, year: 2000, librarySectionID: Number(section) }]
        : [];
      return { items, total: 1 };
    }),
    getItemMetadata: vi.fn(async () => { throw new Error("unused"); }),
  })),
}));

import { POST as byTypePOST } from "@/app/api/sync/by-type/route";
import { POST as cancelPOST } from "@/app/api/sync/cancel/route";
import { GET as statusGET } from "@/app/api/sync/status/route";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { TASK_SYNC_SERVER } from "@/lib/jobs/constants";

const prisma = getTestPrisma();

async function activeRows(): Promise<string[]> {
  const body = await expectJson<{ jobs: Array<{ status: string }> }>(await callRoute(statusGET, { url: "/api/sync/status" }), 200);
  return body.jobs.map((job) => job.status).filter((status) => status === "RUNNING" || status === "PENDING");
}

describe("a library-page Sync over several libraries", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    state.onSection = null;
    state.enqueued = [];
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("stays active between libraries, and Stop reaches the ones still queued", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    for (const [key, title] of [["1", "Movies A"], ["2", "Movies B"], ["3", "Movies C"]]) {
      await createTestLibrary(server.id, { key, title, type: "MOVIE" });
    }
    setMockSession({ userId: user.id, isLoggedIn: true });

    await expectJson(await callRoute(byTypePOST, { url: "/api/sync/by-type", method: "POST", body: { libraryType: "MOVIE" } }), 200);
    const jobs = state.enqueued
      .filter((job) => job.identifier === TASK_SYNC_SERVER)
      .map((job) => job.payload as { libraryKey: string; syncJobId: string });
    expect(jobs.map((job) => job.libraryKey)).toEqual(["1", "2", "3"]);
    const run = (index: number) =>
      syncMediaServer(server.id, jobs[index].libraryKey, { syncJobId: jobs[index].syncJobId, skipWatchHistory: true });

    // The first library finishes; the other two are still queued and show.
    await run(0);
    expect(await activeRows()).toEqual(["PENDING", "PENDING"]);

    // Stop is pressed while the second library syncs.
    state.onSection = async (section) => {
      if (section !== "2") return;
      await expectJson(await callRoute(cancelPOST, { url: "/api/sync/cancel", method: "POST", body: { serverId: server.id } }), 200);
    };
    await run(1);
    state.onSection = null;

    // The third library's job runs afterwards and finds its row stopped.
    await run(2);
    expect(await prisma.mediaItem.count({ where: { ratingKey: "m3" } })).toBe(0);
    expect(await activeRows()).toEqual([]);
  });
});
