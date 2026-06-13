import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestRadarrInstance,
  createTestSonarrInstance,
} from "../../setup/test-helpers";
import type { QueryResult } from "@/lib/query/query-engine";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the query engine — the route uses it for re-validation + series grouping.
vi.mock("@/lib/query/query-engine", () => ({
  executeQuery: vi.fn(),
}));

// Mock executeAction to avoid real Arr API calls (keep normalizeTitle/extractActionError real).
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn().mockResolvedValue(undefined) };
});

// Import AFTER mocks
import { POST } from "@/app/api/query/actions/route";
import { executeQuery } from "@/lib/query/query-engine";
import { executeAction } from "@/lib/lifecycle/actions";

const mockedExecuteQuery = vi.mocked(executeQuery);
const mockedExecuteAction = vi.mocked(executeAction);

function queryResult(items: Array<Record<string, unknown>>): QueryResult {
  return { items, pagination: { page: 1, limit: 0, hasMore: false, total: items.length } };
}

const BASE_QUERY = {
  mediaTypes: [],
  serverIds: [],
  groups: [],
  sortBy: "title",
  sortOrder: "asc" as const,
  includeEpisodes: false,
};

describe("POST /api/query/actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      method: "POST",
      body: { query: BASE_QUERY, mediaItemIds: ["x"], actionType: "DELETE_RADARR" },
    });
    await expectJson(response, 401);
  });

  it("executes a movie delete and records an ad-hoc COMPLETED action", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Dune" });
    await createTestExternalId(movie.id, "TMDB", "12345");
    const radarr = await createTestRadarrInstance(user.id);

    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: movie.id, type: "MOVIE", title: "Dune", parentTitle: null }]));

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [movie.id],
        actionType: "DELETE_RADARR",
        arrInstanceId: radarr.id,
      },
    });

    const body = await expectJson<{ executed: number; failed: number; skipped: number }>(response, 200);
    expect(body).toMatchObject({ executed: 1, failed: 0, skipped: 0 });
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);

    const prisma = getTestPrisma();
    const actions = await prisma.lifecycleAction.findMany({ where: { userId: user.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "COMPLETED",
      ruleSetId: null,
      ruleSetName: "Ad-hoc query action",
      ruleSetType: "MOVIE",
      actionType: "DELETE_RADARR",
    });
  });

  it("rejects an unknown action type", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const radarr = await createTestRadarrInstance(user.id);

    const response = await callRoute(POST, {
      method: "POST",
      body: { query: BASE_QUERY, mediaItemIds: ["a"], actionType: "DROP_TABLE", arrInstanceId: radarr.id },
    });
    await expectJson(response, 400);
    expect(mockedExecuteQuery).not.toHaveBeenCalled();
  });

  it("rejects an action that needs an Arr instance when none is given", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      method: "POST",
      body: { query: BASE_QUERY, mediaItemIds: ["a"], actionType: "DELETE_RADARR" },
    });
    await expectJson(response, 400);
    expect(mockedExecuteQuery).not.toHaveBeenCalled();
  });

  it("rejects CHANGE_QUALITY_PROFILE without a target profile", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const radarr = await createTestRadarrInstance(user.id);

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: ["a"],
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        arrInstanceId: radarr.id,
      },
    });
    await expectJson(response, 400);
  });

  it("executes a quality profile change with search-after and records both fields", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Dune" });
    await createTestExternalId(movie.id, "TMDB", "12345");
    const radarr = await createTestRadarrInstance(user.id);

    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: movie.id, type: "MOVIE", title: "Dune", parentTitle: null }]));

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [movie.id],
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        arrInstanceId: radarr.id,
        targetQualityProfileId: 7,
        searchAfterAction: true,
      },
    });

    const body = await expectJson<{ executed: number; failed: number; skipped: number }>(response, 200);
    expect(body).toMatchObject({ executed: 1, failed: 0, skipped: 0 });
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAction.mock.calls[0][0]).toMatchObject({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
      searchAfterAction: true,
    });

    const prisma = getTestPrisma();
    const actions = await prisma.lifecycleAction.findMany({ where: { userId: user.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "COMPLETED",
      ruleSetName: "Ad-hoc query action",
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
      searchAfterAction: true,
      deletedBytes: null,
    });
  });

  it("skips items no longer in the live query result", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const radarr = await createTestRadarrInstance(user.id);

    mockedExecuteQuery.mockResolvedValue(queryResult([])); // nothing matches anymore

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: ["gone"],
        actionType: "DELETE_RADARR",
        arrInstanceId: radarr.id,
      },
    });
    const body = await expectJson<{ executed: number; skipped: number }>(response, 200);
    expect(body).toMatchObject({ executed: 0, skipped: 1 });
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("skips selected items whose media type does not match the action family", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const series = await createTestMediaItem(library.id, { type: "SERIES", title: "Show", parentTitle: "Show" });
    const radarr = await createTestRadarrInstance(user.id);

    // Live result is a SERIES item, but the action targets Radarr (movies).
    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: series.id, type: "SERIES", title: "Show", parentTitle: "Show" }]));

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [series.id],
        actionType: "DELETE_RADARR",
        arrInstanceId: radarr.id,
      },
    });
    const body = await expectJson<{ executed: number; skipped: number }>(response, 200);
    expect(body).toMatchObject({ executed: 0, skipped: 1 });
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("excludes items that have a LifecycleException", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Excepted" });
    const radarr = await createTestRadarrInstance(user.id);
    const prisma = getTestPrisma();
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: movie.id } });

    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: movie.id, type: "MOVIE", title: "Excepted", parentTitle: null }]));

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [movie.id],
        actionType: "DELETE_RADARR",
        arrInstanceId: radarr.id,
      },
    });
    const body = await expectJson<{ executed: number; skipped: number; errors: string[] }>(response, 200);
    expect(body.executed).toBe(0);
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("resolves grouped-series member episode IDs for file-deletion actions", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(library.id, { type: "SERIES", title: "S1E1", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(library.id, { type: "SERIES", title: "S1E2", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 2 });
    await createTestExternalId(ep1.id, "TVDB", "81189");
    const sonarr = await createTestSonarrInstance(user.id);

    // First call (grouped, includeEpisodes=false) returns one show row whose
    // representative id is ep1. Second call (includeEpisodes=true) returns the
    // flat episode list.
    mockedExecuteQuery.mockImplementation(async (q: { includeEpisodes?: boolean }) => {
      if (q.includeEpisodes) {
        return queryResult([
          { id: ep1.id, type: "SERIES", title: "S1E1", parentTitle: "Breaking Bad" },
          { id: ep2.id, type: "SERIES", title: "S1E2", parentTitle: "Breaking Bad" },
        ]);
      }
      return queryResult([{ id: ep1.id, type: "SERIES", title: "Breaking Bad", parentTitle: null }]);
    });

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [ep1.id],
        actionType: "DELETE_FILES_SONARR",
        arrInstanceId: sonarr.id,
      },
    });
    const body = await expectJson<{ executed: number }>(response, 200);
    expect(body.executed).toBe(1);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);
    const passed = mockedExecuteAction.mock.calls[0][0];
    expect(new Set(passed.matchedMediaItemIds)).toEqual(new Set([ep1.id, ep2.id]));
  });

  it("filters individually-excepted member episodes out of a grouped-series action", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(library.id, { type: "SERIES", title: "S1E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(library.id, { type: "SERIES", title: "S1E2", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2 });
    const sonarr = await createTestSonarrInstance(user.id);
    const prisma = getTestPrisma();
    // Except just ep2 — it must not be in the deletion set.
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: ep2.id } });

    mockedExecuteQuery.mockImplementation(async (q: { includeEpisodes?: boolean }) => {
      if (q.includeEpisodes) {
        return queryResult([
          { id: ep1.id, type: "SERIES", title: "S1E1", parentTitle: "Show" },
          { id: ep2.id, type: "SERIES", title: "S1E2", parentTitle: "Show" },
        ]);
      }
      return queryResult([{ id: ep1.id, type: "SERIES", title: "Show", parentTitle: null }]);
    });

    const response = await callRoute(POST, {
      method: "POST",
      body: { query: BASE_QUERY, mediaItemIds: [ep1.id], actionType: "DELETE_FILES_SONARR", arrInstanceId: sonarr.id },
    });
    const body = await expectJson<{ executed: number }>(response, 200);
    expect(body.executed).toBe(1);
    const passed = mockedExecuteAction.mock.calls[0][0];
    expect(passed.matchedMediaItemIds).toEqual([ep1.id]); // ep2 excluded
  });

  it("skips a grouped-series action when every member episode is excepted", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(library.id, { type: "SERIES", title: "S1E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });
    const sonarr = await createTestSonarrInstance(user.id);
    const prisma = getTestPrisma();
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: ep1.id } });

    mockedExecuteQuery.mockImplementation(async (q: { includeEpisodes?: boolean }) => {
      if (q.includeEpisodes) {
        return queryResult([{ id: ep1.id, type: "SERIES", title: "S1E1", parentTitle: "Show" }]);
      }
      return queryResult([{ id: ep1.id, type: "SERIES", title: "Show", parentTitle: null }]);
    });

    const response = await callRoute(POST, {
      method: "POST",
      body: { query: BASE_QUERY, mediaItemIds: [ep1.id], actionType: "DELETE_FILES_SONARR", arrInstanceId: sonarr.id },
    });
    const body = await expectJson<{ executed: number; skipped: number }>(response, 200);
    expect(body.executed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("does not bleed episodes across distinct shows that share a normalized title", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    // Two distinct shows that collapse under normalizeTitle ("office") but are
    // separate groups under LOWER(TRIM(parentTitle)).
    const usEp = await createTestMediaItem(library.id, { type: "SERIES", title: "US S1E1", parentTitle: "The Office (US)", seasonNumber: 1, episodeNumber: 1 });
    const ukEp = await createTestMediaItem(library.id, { type: "SERIES", title: "UK S1E1", parentTitle: "The Office (UK)", seasonNumber: 1, episodeNumber: 1 });
    const sonarr = await createTestSonarrInstance(user.id);

    mockedExecuteQuery.mockImplementation(async (q: { includeEpisodes?: boolean }) => {
      if (q.includeEpisodes) {
        return queryResult([
          { id: usEp.id, type: "SERIES", title: "US S1E1", parentTitle: "The Office (US)" },
          { id: ukEp.id, type: "SERIES", title: "UK S1E1", parentTitle: "The Office (UK)" },
        ]);
      }
      // Grouped result: representative row for the US show only.
      return queryResult([{ id: usEp.id, type: "SERIES", title: "The Office (US)", parentTitle: null }]);
    });

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [usEp.id],
        actionType: "DELETE_FILES_SONARR",
        arrInstanceId: sonarr.id,
      },
    });
    await expectJson(response, 200);
    const passed = mockedExecuteAction.mock.calls[0][0];
    // Only the US episode — must NOT include the UK show's episode.
    expect(passed.matchedMediaItemIds).toEqual([usEp.id]);
  });

  it("records a FAILED action and surfaces the error when execution throws", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const library = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Boom" });
    const radarr = await createTestRadarrInstance(user.id);

    mockedExecuteQuery.mockResolvedValue(queryResult([{ id: movie.id, type: "MOVIE", title: "Boom", parentTitle: null }]));
    mockedExecuteAction.mockRejectedValueOnce(new Error("Radarr exploded"));

    const response = await callRoute(POST, {
      method: "POST",
      body: {
        query: BASE_QUERY,
        mediaItemIds: [movie.id],
        actionType: "DELETE_RADARR",
        arrInstanceId: radarr.id,
      },
    });
    const body = await expectJson<{ executed: number; failed: number; errors: string[] }>(response, 200);
    expect(body).toMatchObject({ executed: 0, failed: 1 });
    expect(body.errors[0]).toContain("Radarr exploded");

    const prisma = getTestPrisma();
    const actions = await prisma.lifecycleAction.findMany({ where: { userId: user.id } });
    expect(actions[0].status).toBe("FAILED");
  });
});
