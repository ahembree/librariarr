/**
 * Query "Delete files" on a query mixing a series criterion with a per-episode
 * one, against the REAL query engine (query-actions.test.ts mocks it).
 *
 * Regression: the engine's series-aggregate path returned every episode of a
 * show that passed as a whole, and the aggregate reads per-episode fields off
 * its representative episode. "Available Episode Count ≥ 3 and Resolution =
 * 4K" on a show whose first episode is 4K and the rest 1080p therefore handed
 * the route all three episodes — in the episode view, and in the grouped
 * view's re-run in episode view that resolves a show's members — and the file
 * delete removed the 1080p files too.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestSonarrInstance,
} from "../../setup/test-helpers";
import { compareIds } from "@/lib/conditions/compare-ids";
import { appCache } from "@/lib/cache/memory-cache";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// No Arr calls: the action itself is recorded, not sent.
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn(async () => {}) };
});

import { POST } from "@/app/api/query/actions/route";
import { executeAction } from "@/lib/lifecycle/actions";

const mockedExecuteAction = vi.mocked(executeAction);

describe("POST /api/query/actions — series criterion with a per-episode criterion", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    mockedExecuteAction.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seed() {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const ids: string[] = [];
    for (let e = 1; e <= 3; e++) {
      const ep = await createTestMediaItem(library.id, {
        type: "SERIES", title: `S1E${e}`, parentTitle: "Mixed Show",
        seasonNumber: 1, episodeNumber: e, resolution: "1080",
      });
      await createTestExternalId(ep.id, "TVDB", "424242");
      ids.push(ep.id);
    }
    // The first episode — the aggregate's representative — is the 4K one.
    const [fourK, ...hd] = [...ids].sort(compareIds);
    await getTestPrisma().mediaItem.update({ where: { id: fourK }, data: { resolution: "4k" } });
    const sonarr = await createTestSonarrInstance(user.id);
    return { serverId: server.id, sonarrId: sonarr.id, fourK, hd };
  }

  function query(serverId: string, includeEpisodes: boolean) {
    return {
      mediaTypes: ["SERIES"],
      serverIds: [serverId],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3", condition: "AND" },
            { id: "r2", field: "resolution", operator: "equals", value: "4K", condition: "AND" },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
      includeEpisodes,
    };
  }

  it("deletes only the 4K episode's file from the grouped show row", async () => {
    const { serverId, sonarrId, fourK } = await seed();

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: query(serverId, false),
        mediaItemIds: [fourK],
        actionType: "DELETE_FILES_SONARR",
        arrInstanceId: sonarrId,
      },
    });
    const { result } = await expectStreamResult<{ executed: number }>(response);

    expect(result.executed).toBe(1);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual([fourK]);
  });

  it("refuses the 1080p episodes in the episode view", async () => {
    const { serverId, sonarrId, fourK, hd } = await seed();

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: query(serverId, true),
        mediaItemIds: [fourK, ...hd],
        actionType: "DELETE_FILES_SONARR",
        arrInstanceId: sonarrId,
      },
    });
    const { result } = await expectStreamResult<{ executed: number; skipped: number }>(response);

    expect(result.executed).toBe(1);
    expect(result.skipped).toBe(2);
    const acted = mockedExecuteAction.mock.calls.flatMap(([action]) => action.matchedMediaItemIds ?? []);
    expect(acted).toEqual([fourK]);
  });
});
