/**
 * `executeActionsForItems` (the manual Execute route, the query page's actions)
 * writes its history row with `mediaItemId` set. A sync can purge the item's
 * row while its Arr call runs; the write then failed its foreign key, the
 * catch wrote a FAILED row with the same dangling id, that threw too, and the
 * whole run aborted — the deletion that DID happen had no history and the
 * remaining items were never processed. The scheduled executor has handled
 * this all along (`recordVanishedAction`).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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
const executeActionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: executeActionMock };
});

import { executeActionsForItems } from "@/lib/lifecycle/run-actions";

describe("executeActionsForItems when an item's row vanishes mid-call", () => {
  beforeEach(async () => {
    await cleanDatabase();
    executeActionMock.mockReset();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("records the action and carries on with the remaining items", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const first = await createTestMediaItem(library.id, { title: "First" });
    const second = await createTestMediaItem(library.id, { title: "Second" });
    const items = await prisma.mediaItem.findMany({
      where: { id: { in: [first.id, second.id] } }, include: { externalIds: true }, orderBy: { title: "asc" },
    });

    // The Arr delete of "First" succeeds; while it runs, a sync purges the row.
    executeActionMock.mockImplementation(async (action: { mediaItem: { id: string } }) => {
      if (action.mediaItem.id === first.id) await prisma.mediaItem.delete({ where: { id: first.id } });
      return {};
    });

    let thrown: unknown = null;
    let result: Awaited<ReturnType<typeof executeActionsForItems>> | null = null;
    try {
      result = await executeActionsForItems(
        user.id, items,
        { actionType: "DELETE_RADARR", arrInstanceId: "radarr-1", targetQualityProfileId: null, addImportExclusion: false, searchAfterAction: false, addArrTags: [], removeArrTags: [] },
        new Map(),
        { ruleSetId: null, ruleSetName: "Ad-hoc query action", ruleSetType: "MOVIE", cleanupMatches: false },
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeNull();
    // Both items were sent to the Arr app...
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    // ...and both runs are in the history.
    expect(result).toMatchObject({ executed: 2, failed: 0 });
    // The vanished item's row is recorded without its dangling item link.
    const completed = await prisma.lifecycleAction.findMany({
      where: { status: "COMPLETED" }, orderBy: { mediaItemTitle: "asc" },
    });
    expect(completed.map((a) => [a.mediaItemTitle, a.mediaItemId])).toEqual([
      ["First", null],
      ["Second", second.id],
    ]);
  });

  it("records a failure on a vanished item and carries on", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const first = await createTestMediaItem(library.id, { title: "First" });
    const second = await createTestMediaItem(library.id, { title: "Second" });
    const items = await prisma.mediaItem.findMany({
      where: { id: { in: [first.id, second.id] } }, include: { externalIds: true }, orderBy: { title: "asc" },
    });

    executeActionMock.mockImplementation(async (action: { mediaItem: { id: string } }) => {
      if (action.mediaItem.id === first.id) {
        await prisma.mediaItem.delete({ where: { id: first.id } });
        throw new Error("HTTP 504: timed out");
      }
      return {};
    });

    const result = await executeActionsForItems(
      user.id, items,
      { actionType: "DELETE_RADARR", arrInstanceId: "radarr-1", targetQualityProfileId: null, addImportExclusion: false, searchAfterAction: false, addArrTags: [], removeArrTags: [] },
      new Map(),
      { ruleSetId: null, ruleSetName: "Ad-hoc query action", ruleSetType: "MOVIE", cleanupMatches: false },
    );

    expect(result).toMatchObject({ executed: 1, failed: 1 });
    expect(executeActionMock).toHaveBeenCalledTimes(2);
    const failed = await prisma.lifecycleAction.findFirstOrThrow({ where: { status: "FAILED" } });
    expect(failed).toMatchObject({ mediaItemId: null, mediaItemTitle: "First" });
    expect(failed.error).toContain("timed out");
    const completed = await prisma.lifecycleAction.findMany({ where: { status: "COMPLETED" } });
    expect(completed.map((a) => [a.mediaItemTitle, a.mediaItemId])).toEqual([["Second", second.id]]);
  });
});
