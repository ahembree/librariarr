/** Extra coverage for POST /api/query/actions: instance/family resolution and single-flight. */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
} from "../../setup/test-helpers";
import type { QueryResult } from "@/lib/query/query-engine";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/query/query-engine", () => ({ executeQuery: vi.fn() }));
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn().mockResolvedValue({}) };
});

import { POST } from "@/app/api/query/actions/route";
import { executeQuery } from "@/lib/query/query-engine";
import { executeAction } from "@/lib/lifecycle/actions";
import { tryBeginExecute, endExecute, queryExecuteKey } from "@/lib/lifecycle/execute-in-flight";

const mockedExecuteQuery = vi.mocked(executeQuery);
const mockedExecuteAction = vi.mocked(executeAction);

const BASE_QUERY = { mediaTypes: [], serverIds: [], groups: [], sortBy: "title", sortOrder: "asc" as const, includeEpisodes: false };
const queryResult = (items: Array<Record<string, unknown>>): QueryResult =>
  ({ items, pagination: { page: 1, limit: 0, hasMore: false, total: items.length } }) as QueryResult;

const post = (body: Record<string, unknown>) => callRoute(POST, { method: "POST", body: { query: BASE_QUERY, ...body } });

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; a re-query answer must not carry over.
  mockedExecuteQuery.mockReset();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("POST /api/query/actions — action configuration", () => {
  it("refuses Do Nothing with no tag operations", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<{ error: string }>(await post({ mediaItemIds: ["x"], actionType: "DO_NOTHING" }), 400);
    expect(body.error).toBe("No action configured");
    expect(mockedExecuteQuery).not.toHaveBeenCalled();
  });

  it("refuses an Arr instance of the wrong family for the action", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const sonarr = await createTestSonarrInstance(user.id);
    const body = await expectJson<{ error: string }>(
      await post({ mediaItemIds: ["x"], actionType: "DELETE_RADARR", arrInstanceId: sonarr.id }),
      404,
    );
    expect(body.error).toBe("Arr instance not found for this action type");
  });

  it("refuses tag-only Do Nothing on an instance that does not exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<{ error: string }>(
      await post({ mediaItemIds: ["x"], actionType: "DO_NOTHING", addArrTags: ["t"], arrInstanceId: "no-such-instance" }),
      404,
    );
    expect(body.error).toBe("Arr instance not found");
  });

  it.each([
    ["Radarr", "MOVIE", createTestRadarrInstance],
    ["Sonarr", "SERIES", createTestSonarrInstance],
    ["Lidarr", "MUSIC", createTestLidarrInstance],
  ] as const)("infers the media type of tag-only Do Nothing from a %s instance", async (_n, type, makeInstance) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type });
    const item = await createTestMediaItem(lib.id, {
      type, title: "Item", parentTitle: type === "MOVIE" ? null : "Parent",
      ...(type === "SERIES" ? { seasonNumber: 1, episodeNumber: 1 } : {}),
    });
    await createTestExternalId(
      item.id,
      type === "MOVIE" ? "TMDB" : type === "SERIES" ? "TVDB" : "MUSICBRAINZ",
      type === "MUSIC" ? "a74b1b7f-71a5-4011-9441-d0b5e4122711" : "42",
    );
    const instance = await makeInstance(user.id);
    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: item.id, type, title: "Item", parentTitle: item.parentTitle }]));

    const { result } = await expectStreamResult<{ executed: number }>(
      await post({ mediaItemIds: [item.id], actionType: "DO_NOTHING", removeArrTags: ["old"], arrInstanceId: instance.id }),
    );

    expect(result.executed).toBe(1);
    expect(mockedExecuteAction.mock.calls[0][0]).toMatchObject({ actionType: "DO_NOTHING", removeArrTags: ["old"], arrInstanceId: instance.id });
  });
});

describe("POST /api/query/actions — single-flight", () => {
  it("answers 409 while another query action of the same user is running", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const radarr = await createTestRadarrInstance(user.id);
    const key = queryExecuteKey(user.id);
    expect(tryBeginExecute(key)).toBe(true);
    try {
      const body = await expectJson<{ error: string }>(
        await post({ mediaItemIds: ["x"], actionType: "DELETE_RADARR", arrInstanceId: radarr.id }),
        409,
      );
      expect(body.error).toMatch(/already running/);
      expect(mockedExecuteAction).not.toHaveBeenCalled();
    } finally {
      endExecute(key);
    }
  });
});
