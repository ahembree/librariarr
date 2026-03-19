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
const mockGroupSeriesResults = vi.hoisted(() => vi.fn().mockImplementation((items: unknown[]) => items));
const mockGetMatchedCriteriaForItems = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockGetActualValuesForAllRules = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));

vi.mock("@/lib/rules/engine", () => ({
  evaluateRules: mockEvaluateRules,
  evaluateSeriesScope: mockEvaluateSeriesScope,
  evaluateMusicScope: mockEvaluateMusicScope,
  hasArrRules: mockHasArrRules,
  hasSeerrRules: mockHasSeerrRules,
  hasAnyActiveRules: mockHasAnyActiveRules,
  groupSeriesResults: mockGroupSeriesResults,
  getMatchedCriteriaForItems: mockGetMatchedCriteriaForItems,
  getActualValuesForAllRules: mockGetActualValuesForAllRules,
}));

vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: vi.fn().mockResolvedValue({}),
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
    mockEvaluateRules.mockResolvedValue([]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const validRules = [{ field: "playCount", operator: "equals", value: 0 }];

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
});
