import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
} from "../../setup/test-helpers";

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

// Mock rule engine functions
const mockEvaluateRules = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockEvaluateSeriesScope = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockEvaluateMusicScope = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockHasArrRules = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockHasSeerrRules = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockHasAnyActiveRules = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockHasWatchedByUserRules = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockGroupSeriesResults = vi.hoisted(() => vi.fn().mockImplementation((items: unknown[]) => items));
const mockGetMatchedCriteriaForItems = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockGetActualValuesForAllRules = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));

vi.mock("@/lib/rules/lifecycle-engine", () => ({
  evaluateLifecycleRules: mockEvaluateRules,
  evaluateSeriesScope: mockEvaluateSeriesScope,
  evaluateMusicScope: mockEvaluateMusicScope,
  hasArrRules: mockHasArrRules,
  hasSeerrRules: mockHasSeerrRules,
  hasAnyActiveRules: mockHasAnyActiveRules,
  hasWatchedByUserRules: mockHasWatchedByUserRules,
  groupSeriesResults: mockGroupSeriesResults,
  getMatchedCriteriaForItems: mockGetMatchedCriteriaForItems,
  getActualValuesForAllRules: mockGetActualValuesForAllRules,
}));

const mockHasEnabledArrInstances = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockHasEnabledSeerrInstances = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: vi.fn().mockResolvedValue({}),
  hasEnabledArrInstances: mockHasEnabledArrInstances,
  arrFamilyLabel: (type: string) =>
    type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr",
}));

vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: vi.fn().mockResolvedValue({}),
  hasEnabledSeerrInstances: mockHasEnabledSeerrInstances,
}));

// Import AFTER mocks
import { POST } from "@/app/api/lifecycle/rules/[id]/diff/route";

describe("POST /api/lifecycle/rules/[id]/diff", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
    mockEvaluateRules.mockResolvedValue([]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const validRules = [{ field: "playCount", operator: "equals", value: 0 }];

  const activeGroup = validRules;

  /** A user + server + library + rule set of the given type. */
  async function seedSeriesFixture(type: "SERIES" | "MOVIE" = "SERIES") {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type });
    const ruleSet = await createTestRuleSet(user.id, { name: "Shape test", type });
    return { user, server, library, ruleSet };
  }

  it("returns 401 when not authenticated", async () => {
    const response = await callRouteWithParams(
      POST,
      { id: "some-id" },
      {
        url: "/api/lifecycle/rules/some-id/diff",
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: ["s1"] },
      }
    );
    await expectJson(response, 401);
  });

  it("returns 400 when rules use Arr criteria and no enabled Arr instance exists (match-all guard)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const ruleSet = await createTestRuleSet(user.id, { name: "Arr diff", type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockHasArrRules.mockReturnValue(true);
    mockHasEnabledArrInstances.mockResolvedValue(false);

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: {
          rules: [{ field: "foundInArr", operator: "equals", value: "false" }],
          type: "MOVIE",
          serverIds: [server.id],
        },
      }
    );

    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toMatch(/no enabled Radarr instance/i);
    // The vacuous whole-library evaluation never runs
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body (missing rules)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: "some-id" },
      {
        url: "/api/lifecycle/rules/some-id/diff",
        method: "POST",
        body: { type: "MOVIE", serverIds: ["s1"] },
      }
    );
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for invalid body (missing serverIds)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: "some-id" },
      {
        url: "/api/lifecycle/rules/some-id/diff",
        method: "POST",
        body: { rules: validRules, type: "MOVIE" },
      }
    );
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 404 for non-existent rule set", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: "nonexistent" },
      {
        url: "/api/lifecycle/rules/nonexistent/diff",
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: ["s1"] },
      }
    );
    await expectJson(response, 404);
  });

  it("returns 404 for another user's rule set", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "intruder" });
    const ruleSet = await createTestRuleSet(user1.id, { name: "Private" });

    setMockSession({ isLoggedIn: true, userId: user2.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: ["s1"] },
      }
    );
    await expectJson(response, 404);
  });

  it("returns all existing matches as removed when no active rules", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);

    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie A", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Test" });
    await createTestRuleMatch(ruleSet.id, item.id, { title: "Movie A", parentTitle: null });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: [server.id] },
      }
    );

    const body = await expectJson<{
      added: unknown[];
      removed: { id: string; title: string }[];
      retained: unknown[];
      counts: { added: number; removed: number; retained: number };
    }>(response, 200);

    expect(body.counts.added).toBe(0);
    expect(body.counts.removed).toBe(1);
    expect(body.counts.retained).toBe(0);
    expect(body.removed[0].id).toBe(item.id);
  });

  it("returns added items for new matches not in existing", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "New Movie", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Test" });
    // No existing matches

    mockEvaluateRules.mockResolvedValue([{ id: item.id, title: "New Movie", parentTitle: null }]);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: [server.id] },
      }
    );

    const body = await expectJson<{
      added: { id: string; title: string }[];
      removed: unknown[];
      retained: unknown[];
      counts: { added: number; removed: number; retained: number };
    }>(response, 200);

    expect(body.counts.added).toBe(1);
    expect(body.counts.removed).toBe(0);
    expect(body.counts.retained).toBe(0);
    expect(body.added[0].id).toBe(item.id);
  });

  it("returns retained items for matches in both old and new", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Existing Movie", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Test" });
    await createTestRuleMatch(ruleSet.id, item.id, { title: "Existing Movie", parentTitle: null });

    mockEvaluateRules.mockResolvedValue([{ id: item.id, title: "Existing Movie", parentTitle: null }]);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: [server.id] },
      }
    );

    const body = await expectJson<{
      added: unknown[];
      removed: unknown[];
      retained: { id: string; title: string }[];
      counts: { added: number; removed: number; retained: number };
    }>(response, 200);

    expect(body.counts.added).toBe(0);
    expect(body.counts.removed).toBe(0);
    expect(body.counts.retained).toBe(1);
    expect(body.retained[0].id).toBe(item.id);
  });

  it("computes full diff with added, removed, and retained", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const keptItem = await createTestMediaItem(library.id, { title: "Kept", type: "MOVIE" });
    const removedItem = await createTestMediaItem(library.id, { title: "Removed", type: "MOVIE" });
    const addedItem = await createTestMediaItem(library.id, { title: "Added", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Test" });

    await createTestRuleMatch(ruleSet.id, keptItem.id, { title: "Kept", parentTitle: null });
    await createTestRuleMatch(ruleSet.id, removedItem.id, { title: "Removed", parentTitle: null });

    mockEvaluateRules.mockResolvedValue([
      { id: keptItem.id, title: "Kept", parentTitle: null },
      { id: addedItem.id, title: "Added", parentTitle: null },
    ]);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: [server.id] },
      }
    );

    const body = await expectJson<{
      added: { id: string }[];
      removed: { id: string }[];
      retained: { id: string }[];
      counts: { added: number; removed: number; retained: number };
    }>(response, 200);

    expect(body.counts.added).toBe(1);
    expect(body.counts.removed).toBe(1);
    expect(body.counts.retained).toBe(1);
    expect(body.added[0].id).toBe(addedItem.id);
    expect(body.removed[0].id).toBe(removedItem.id);
    expect(body.retained[0].id).toBe(keptItem.id);
  });

  it("returns removed SERIES rows in series shape, not the representative episode", async () => {
    // A series-scoped match: detection stored the AGGREGATE in itemData
    // (title = show, parentTitle = null, memberIds = every episode), while the
    // MediaItem row behind it is the representative EPISODE.
    const { user, server, library, ruleSet } = await seedSeriesFixture();
    const prisma = getTestPrisma();
    const ep1 = await createTestMediaItem(library.id, {
      ratingKey: "s1e1", type: "SERIES", title: "Pilot",
      parentTitle: "The Show", seasonNumber: 1, episodeNumber: 1,
      fileSize: BigInt(1_000_000_000), playCount: 2,
    });
    const ep2 = await createTestMediaItem(library.id, {
      ratingKey: "s1e2", type: "SERIES", title: "Second Episode",
      parentTitle: "The Show", seasonNumber: 1, episodeNumber: 2,
      fileSize: BigInt(3_000_000_000), playCount: 1,
    });
    await createTestRuleMatch(ruleSet.id, ep1.id, {
      id: ep1.id, title: "The Show", parentTitle: null,
      matchedEpisodes: 2, memberIds: [ep1.id, ep2.id],
      fileSize: "4000000000",
    });

    // New evaluation matches nothing → the series is removed.
    mockEvaluateSeriesScope.mockResolvedValueOnce([]);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRouteWithParams(POST, { id: ruleSet.id }, {
      method: "POST",
      body: { rules: activeGroup, type: "SERIES", seriesScope: true, serverIds: [server.id] },
    });
    const body = await expectJson<{
      removed: Array<{ title: string; parentTitle: string | null }>;
      removedItems: Array<Record<string, unknown>>;
    }>(response, 200);

    expect(body.removed).toHaveLength(1);
    expect(body.removedItems).toHaveLength(1);
    const row = body.removedItems[0];

    // The table picks its title format off `matchedEpisodes`: without it the row
    // falls into the per-episode branch and renders "The Show — Pilot".
    expect(row.matchedEpisodes).toBe(2);
    expect(row.parentTitle ?? row.title).toBe("The Show");
    expect(row.title).not.toBe("Pilot");
    // …and the size shown is the series total, not the one episode's.
    expect(String(row.fileSize)).toBe("4000000000");
    await prisma.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id } });
  });

  it("returns removed SERIES rows in series shape when the rule set has no active rules", async () => {
    const { user, server, library, ruleSet } = await seedSeriesFixture();
    const ep1 = await createTestMediaItem(library.id, {
      ratingKey: "n1e1", type: "SERIES", title: "Pilot",
      parentTitle: "Another Show", seasonNumber: 1, episodeNumber: 1,
      fileSize: BigInt(1_000_000_000),
    });
    const ep2 = await createTestMediaItem(library.id, {
      ratingKey: "n1e2", type: "SERIES", title: "Second Episode",
      parentTitle: "Another Show", seasonNumber: 1, episodeNumber: 2,
      fileSize: BigInt(2_000_000_000),
    });
    await createTestRuleMatch(ruleSet.id, ep1.id, {
      id: ep1.id, title: "Another Show", parentTitle: null,
      matchedEpisodes: 2, memberIds: [ep1.id, ep2.id],
    });

    mockHasAnyActiveRules.mockReturnValueOnce(false);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRouteWithParams(POST, { id: ruleSet.id }, {
      method: "POST",
      body: { rules: activeGroup, type: "SERIES", seriesScope: true, serverIds: [server.id] },
    });
    const body = await expectJson<{ removedItems: Array<Record<string, unknown>> }>(response, 200);

    expect(body.removedItems).toHaveLength(1);
    expect(body.removedItems[0].matchedEpisodes).toBe(2);
    expect(body.removedItems[0].parentTitle ?? body.removedItems[0].title).toBe("Another Show");
    expect(String(body.removedItems[0].fileSize)).toBe("3000000000");
  });

  it("leaves MOVIE rows untouched — they have no group to aggregate", async () => {
    const { user, server, library, ruleSet } = await seedSeriesFixture("MOVIE");
    const movie = await createTestMediaItem(library.id, {
      ratingKey: "m1", type: "MOVIE", title: "A Movie", fileSize: BigInt(5_000_000_000),
    });
    await createTestRuleMatch(ruleSet.id, movie.id, {
      id: movie.id, title: "A Movie", parentTitle: null,
    });

    mockEvaluateRules.mockResolvedValueOnce([]);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRouteWithParams(POST, { id: ruleSet.id }, {
      method: "POST",
      body: { rules: activeGroup, type: "MOVIE", seriesScope: false, serverIds: [server.id] },
    });
    const body = await expectJson<{ removedItems: Array<Record<string, unknown>> }>(response, 200);

    expect(body.removedItems).toHaveLength(1);
    expect(body.removedItems[0].title).toBe("A Movie");
    expect(body.removedItems[0].matchedEpisodes).toBeUndefined();
    expect(String(body.removedItems[0].fileSize)).toBe("5000000000");
  });

  it("excludes items with lifecycle exceptions", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Excluded", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, { name: "Test" });

    const prisma = getTestPrisma();
    await prisma.lifecycleException.create({
      data: { userId: user.id, mediaItemId: item.id },
    });

    mockEvaluateRules.mockResolvedValue([{ id: item.id, title: "Excluded", parentTitle: null }]);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
        method: "POST",
        body: { rules: validRules, type: "MOVIE", serverIds: [server.id] },
      }
    );

    const body = await expectJson<{
      added: unknown[];
      counts: { added: number; removed: number; retained: number };
    }>(response, 200);

    expect(body.counts.added).toBe(0);
  });

  describe("watchedByUser: the removed-item eager load", () => {
    // The diff is what a user reads BEFORE saving a rule edit that arms a
    // DELETE. It re-runs the Phase-2 evaluator over the removed items to
    // annotate them with `matchedCriteria` / `actualValues`, and that eager load
    // has to apply the same completed-play predicate Phase 1 does
    // (`COMPLETED_PLAY_FILTER` in `where-builder.ts`). Loading every row instead
    // makes a 4%-complete abandoned Tracearr play read as a watch here and
    // nowhere else, so the preview explains an item with evidence the engine
    // that will actually delete it never saw.
    it("hides abandoned plays from the removed items it annotates", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const removedItem = await createTestMediaItem(library.id, { title: "Removed", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Test" });
      await createTestRuleMatch(ruleSet.id, removedItem.id, { title: "Removed", parentTitle: null });

      const prisma = getTestPrisma();
      await prisma.watchHistory.createMany({
        data: [
          {
            mediaItemId: removedItem.id,
            mediaServerId: server.id,
            serverUsername: "alice",
            watchedAt: new Date("2025-01-01T00:00:00Z"),
            source: "TRACEARR",
            sourceEventId: "chain-abandoned",
            // Tracearr's completion verdict: this play never reached the
            // threshold, so it does not count as a watch.
            watched: false,
          },
          {
            mediaItemId: removedItem.id,
            mediaServerId: server.id,
            serverUsername: "bob",
            watchedAt: new Date("2025-01-02T00:00:00Z"),
            source: "TRACEARR",
            sourceEventId: "chain-finished",
            watched: true,
          },
        ],
      });

      mockHasWatchedByUserRules.mockReturnValue(true);
      mockEvaluateRules.mockResolvedValue([]);
      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRouteWithParams(
        POST,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}/diff`,
          method: "POST",
          body: {
            rules: [{ field: "watchedByUser", operator: "notEquals", value: "alice" }],
            type: "MOVIE",
            serverIds: [server.id],
          },
        }
      );

      // The evaluator is handed the item; assert on the watch history it was
      // given, which is the thing the eager load controls.
      const [records] = mockGetMatchedCriteriaForItems.mock.calls.at(-1) as [
        Array<{ watchHistory?: Array<{ serverUsername: string }> }>,
      ];
      const names = (records[0]?.watchHistory ?? []).map((w) => w.serverUsername);
      expect(names).toEqual(["bob"]);
      expect(names).not.toContain("alice");
    });
  });

});
