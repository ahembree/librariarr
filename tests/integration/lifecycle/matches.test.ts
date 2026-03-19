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

// Import AFTER mocks
import { GET } from "@/app/api/lifecycle/rules/matches/route";

describe("GET /api/lifecycle/rules/matches", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });
    await expectJson(response, 401);
  });

  it("returns empty ruleMatches when no rule sets exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);
    expect(body.ruleMatches).toEqual([]);
  });

  it("only returns matches for enabled rule sets", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, {
      title: "A Movie",
      type: "MOVIE",
      playCount: 0,
    });

    // One enabled, one disabled
    const enabledRuleSet = await createTestRuleSet(user.id, {
      name: "Enabled Rule",
      type: "MOVIE",
      enabled: true,
      rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    });
    const disabledRuleSet = await createTestRuleSet(user.id, {
      name: "Disabled Rule",
      type: "MOVIE",
      enabled: false,
      rules: [{ id: "r2", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    });

    // Create matches for both — but only the enabled one should be returned
    await createTestRuleMatch(enabledRuleSet.id, item.id, { id: item.id, title: "A Movie", matchedCriteria: [] });
    await createTestRuleMatch(disabledRuleSet.id, item.id, { id: item.id, title: "A Movie", matchedCriteria: [] });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{
      ruleMatches: { ruleSet: { name: string }; items: unknown[]; count: number }[];
    }>(response, 200);

    expect(body.ruleMatches).toHaveLength(1);
    expect(body.ruleMatches[0].ruleSet.name).toBe("Enabled Rule");
  });

  it("returns matches for multiple rule sets", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });

    const item1 = await createTestMediaItem(library.id, {
      title: "Old Unwatched",
      type: "MOVIE",
      playCount: 0,
      year: 2000,
    });
    await createTestMediaItem(library.id, {
      title: "New Watched",
      type: "MOVIE",
      playCount: 5,
      year: 2024,
    });

    // Rule 1: unwatched movies
    const rs1 = await createTestRuleSet(user.id, {
      name: "Unwatched",
      type: "MOVIE",
      enabled: true,
      rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    });

    // Rule 2: old movies
    const rs2 = await createTestRuleSet(user.id, {
      name: "Old Movies",
      type: "MOVIE",
      enabled: true,
      rules: [{ id: "r2", field: "year", operator: "lessThan", value: 2010, condition: "AND" }],
    });

    // Simulate detection results: item1 matches rs1 (unwatched), item1 matches rs2 (old)
    await createTestRuleMatch(rs1.id, item1.id, { id: item1.id, title: "Old Unwatched" });
    await createTestRuleMatch(rs2.id, item1.id, { id: item1.id, title: "Old Unwatched" });

    // item2 doesn't match either (watched + new) — no RuleMatch records

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{
      ruleMatches: { ruleSet: { name: string }; count: number }[];
    }>(response, 200);

    expect(body.ruleMatches).toHaveLength(2);

    const unwatched = body.ruleMatches.find((m) => m.ruleSet.name === "Unwatched");
    const oldMovies = body.ruleMatches.find((m) => m.ruleSet.name === "Old Movies");

    expect(unwatched?.count).toBe(1);
    expect(oldMovies?.count).toBe(1);
  });

  it("does not return matches from other user's rule sets", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });

    const server1 = await createTestServer(user1.id);
    const library1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library1.id, {
      title: "User1 Movie",
      type: "MOVIE",
      playCount: 0,
    });

    const rs = await createTestRuleSet(user1.id, {
      name: "User1 Rule",
      type: "MOVIE",
      enabled: true,
      rules: [],
    });

    await createTestRuleMatch(rs.id, item.id, { id: item.id, title: "User1 Movie" });

    setMockSession({ isLoggedIn: true, userId: user2.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);
    expect(body.ruleMatches).toHaveLength(0);
  });

  it("includes ruleSet metadata in response", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, {
      title: "A Movie",
      type: "MOVIE",
    });

    const rs = await createTestRuleSet(user.id, {
      name: "Metadata Test",
      type: "MOVIE",
      enabled: true,
      actionEnabled: true,
      actionType: "DELETE_RADARR",
      collectionEnabled: true,
      collectionName: "Test Col",
      rules: [],
    });

    await createTestRuleMatch(rs.id, item.id, { id: item.id, title: "A Movie" });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{
      ruleMatches: {
        ruleSet: {
          id: string;
          name: string;
          type: string;
          actionEnabled: boolean;
          actionType: string;
          collectionEnabled: boolean;
          collectionName: string;
        };
      }[];
    }>(response, 200);

    expect(body.ruleMatches).toHaveLength(1);
    const rsMeta = body.ruleMatches[0].ruleSet;
    expect(rsMeta.name).toBe("Metadata Test");
    expect(rsMeta.type).toBe("MOVIE");
    expect(rsMeta.actionEnabled).toBe(true);
    expect(rsMeta.actionType).toBe("DELETE_RADARR");
    expect(rsMeta.collectionEnabled).toBe(true);
    expect(rsMeta.collectionName).toBe("Test Col");
  });

  it("returns items with matchedCriteria array", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, {
      title: "Test Movie",
      type: "MOVIE",
      playCount: 0,
    });

    const rs = await createTestRuleSet(user.id, {
      name: "Criteria Check",
      type: "MOVIE",
      enabled: true,
      rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    });

    // Store item data with matchedCriteria (simulating detectAndSaveMatches output)
    await createTestRuleMatch(rs.id, item.id, {
      id: item.id,
      title: "Test Movie",
      matchedCriteria: [{ field: "playCount", operator: "equals", value: 0 }],
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{
      ruleMatches: {
        items: { title: string; matchedCriteria: unknown[] }[];
      }[];
    }>(response, 200);

    expect(body.ruleMatches).toHaveLength(1);
    expect(body.ruleMatches[0].items).toHaveLength(1);
    // matchedCriteria should be an array
    expect(Array.isArray(body.ruleMatches[0].items[0].matchedCriteria)).toBe(true);
  });

  it("includes rule sets with no matches (count 0)", async () => {
    const user = await createTestUser();

    await createTestRuleSet(user.id, {
      name: "Empty Rule",
      type: "MOVIE",
      enabled: true,
      rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/rules/matches",
    });

    const body = await expectJson<{
      ruleMatches: { ruleSet: { name: string }; items: unknown[]; count: number }[];
    }>(response, 200);
    // Rule set included even with 0 matches
    expect(body.ruleMatches).toHaveLength(1);
    expect(body.ruleMatches[0].ruleSet.name).toBe("Empty Rule");
    expect(body.ruleMatches[0].count).toBe(0);
    expect(body.ruleMatches[0].items).toEqual([]);
  });
});
