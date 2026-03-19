import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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
const mockEvaluateAllRulesInMemory = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockGetMatchedCriteriaForItems = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockGetActualValuesForAllRules = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const mockHasAnyActiveRules = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockHasArrRules = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockHasSeerrRules = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockHasStreamRules = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock("@/lib/rules/engine", () => ({
  evaluateAllRulesInMemory: mockEvaluateAllRulesInMemory,
  getMatchedCriteriaForItems: mockGetMatchedCriteriaForItems,
  getActualValuesForAllRules: mockGetActualValuesForAllRules,
  hasAnyActiveRules: mockHasAnyActiveRules,
  hasArrRules: mockHasArrRules,
  hasSeerrRules: mockHasSeerrRules,
  hasStreamRules: mockHasStreamRules,
}));

vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: vi.fn().mockResolvedValue({}),
}));

// Import AFTER mocks
import { POST } from "@/app/api/lifecycle/rules/test-item/route";

describe("POST /api/lifecycle/rules/test-item", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasStreamRules.mockReturnValue(false);
    mockEvaluateAllRulesInMemory.mockReturnValue(true);
    mockGetMatchedCriteriaForItems.mockReturnValue(new Map());
    mockGetActualValuesForAllRules.mockReturnValue(new Map());
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const validRules = [{ field: "playCount", operator: "equals", value: 0 }];

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: "some-id",
        serverIds: ["s1"],
      },
    });
    await expectJson(response, 401);
  });

  it("returns 400 for missing mediaItemId", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: { rules: validRules, type: "MOVIE", serverIds: ["s1"] },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for missing rules", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: { type: "MOVIE", mediaItemId: "some-id", serverIds: ["s1"] },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for missing serverIds", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: { rules: validRules, type: "MOVIE", mediaItemId: "some-id" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when no active rules", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);

    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: "some-id",
        serverIds: ["s1"],
      },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toContain("No active rules");
  });

  it("returns 404 when media item not found", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: "nonexistent",
        serverIds: ["s1"],
      },
    });
    await expectJson(response, 404);
  });

  it("returns 404 for another user's media item", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "intruder" });
    const server = await createTestServer(user1.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Private Movie", type: "MOVIE" });

    setMockSession({ isLoggedIn: true, userId: user2.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: item.id,
        serverIds: [server.id],
      },
    });
    await expectJson(response, 404);
  });

  it("returns match result for a valid item (matches=true)", async () => {
    mockEvaluateAllRulesInMemory.mockReturnValue(true);
    const criteriaMap = new Map([["item-id", [{ field: "playCount", operator: "equals", value: "0" }]]]);
    const actualMap = new Map([["item-id", new Map([["playCount", "0"]])]]);
    mockGetMatchedCriteriaForItems.mockReturnValue(criteriaMap);
    mockGetActualValuesForAllRules.mockReturnValue(actualMap);

    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, {
      title: "Test Movie",
      type: "MOVIE",
      playCount: 0,
    });

    // Update maps with actual item ID
    criteriaMap.clear();
    criteriaMap.set(item.id, [{ field: "playCount", operator: "equals", value: "0" }]);
    actualMap.clear();
    actualMap.set(item.id, new Map([["playCount", "0"]]));

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: item.id,
        serverIds: [server.id],
      },
    });

    const body = await expectJson<{
      matches: boolean;
      matchedCriteria: unknown[];
      actualValues: Record<string, unknown>;
      item: { id: string; title: string };
    }>(response, 200);

    expect(body.matches).toBe(true);
    expect(body.item.id).toBe(item.id);
    expect(body.item.title).toBe("Test Movie");
  });

  it("returns matches=false when item does not match rules", async () => {
    mockEvaluateAllRulesInMemory.mockReturnValue(false);

    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, {
      title: "Non-matching Movie",
      type: "MOVIE",
      playCount: 5,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/test-item",
      method: "POST",
      body: {
        rules: validRules,
        type: "MOVIE",
        mediaItemId: item.id,
        serverIds: [server.id],
      },
    });

    const body = await expectJson<{
      matches: boolean;
      item: { id: string; title: string };
    }>(response, 200);

    expect(body.matches).toBe(false);
    expect(body.item.id).toBe(item.id);
  });
});
