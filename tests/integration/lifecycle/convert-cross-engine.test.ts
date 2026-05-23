/**
 * Cross-engine consistency: a query converted to a lifecycle rule set
 * should match the same media items when both engines evaluate the same
 * rule tree against the same data. Both engines share the WHERE-clause
 * composition (`buildGroupConditions`) and the same Phase-2 evaluators —
 * this test guards against future drift between them.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import type { QueryDefinition } from "@/lib/query/types";
import { convertQueryToRuleSetBody } from "@/lib/query/convert-to-rule";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { executeQuery } from "@/lib/query/query-engine";
import { evaluateLifecycleRules } from "@/lib/rules/lifecycle-engine";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

interface MatchableItem {
  id: string;
}

function toIdSet(items: MatchableItem[]): Set<string> {
  return new Set(items.map((i) => i.id));
}

describe("Cross-engine: query vs converted lifecycle rule set", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("produces identical match sets for a simple title+playCount AND query", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Matches: title contains "matrix" AND playCount == 0
    const match1 = await createTestMediaItem(library.id, { title: "The Matrix", playCount: 0 });
    const match2 = await createTestMediaItem(library.id, { title: "Matrix Reloaded", playCount: 0 });
    // Same title prefix but watched
    await createTestMediaItem(library.id, { title: "Matrix Revolutions", playCount: 3 });
    // Unwatched but different title
    await createTestMediaItem(library.id, { title: "Inception", playCount: 0 });

    const query: QueryDefinition = {
      mediaTypes: ["MOVIE"],
      serverIds: [server.id],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "title", operator: "contains", value: "matrix", condition: "AND" },
            { id: "r2", field: "playCount", operator: "equals", value: 0, condition: "AND" },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
    };

    const queryResult = await executeQuery(query, user.id, 1, 1000);
    const queryIds = toIdSet(queryResult.items as unknown as MatchableItem[]);
    expect(queryIds).toEqual(new Set([match1.id, match2.id]));

    const body = convertQueryToRuleSetBody(query, {
      name: "Matrix Unwatched",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });
    const ruleMatches = await evaluateLifecycleRules(
      body.rules as unknown as LifecycleRuleGroup[],
      "MOVIE",
      body.serverIds,
    );
    const ruleIds = toIdSet(ruleMatches as unknown as MatchableItem[]);

    expect(ruleIds).toEqual(queryIds);
  });

  it("produces identical match sets for an OR group at the top level", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Match A: 1080p
    const match1 = await createTestMediaItem(library.id, { title: "A", resolution: "1080p" });
    // Match B: SD
    const match2 = await createTestMediaItem(library.id, { title: "B", resolution: "sd" });
    // Not match: 4K
    await createTestMediaItem(library.id, { title: "C", resolution: "4k" });

    const query: QueryDefinition = {
      mediaTypes: ["MOVIE"],
      serverIds: [server.id],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "resolution", operator: "equals", value: "1080p", condition: "OR" },
            { id: "r2", field: "resolution", operator: "equals", value: "sd", condition: "OR" },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
    };

    const queryResult = await executeQuery(query, user.id, 1, 1000);
    const queryIds = toIdSet(queryResult.items as unknown as MatchableItem[]);
    expect(queryIds).toEqual(new Set([match1.id, match2.id]));

    const body = convertQueryToRuleSetBody(query, {
      name: "Low-res movies",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });
    const ruleMatches = await evaluateLifecycleRules(
      body.rules as unknown as LifecycleRuleGroup[],
      "MOVIE",
      body.serverIds,
    );
    expect(toIdSet(ruleMatches as unknown as MatchableItem[])).toEqual(queryIds);
  });

  it("produces identical match sets for a wildcard rule (Phase-2 in both engines)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const match1 = await createTestMediaItem(library.id, { title: "The Matrix" });
    const match2 = await createTestMediaItem(library.id, { title: "Star Wars: A New Hope" });
    await createTestMediaItem(library.id, { title: "Inception" });

    const query: QueryDefinition = {
      mediaTypes: ["MOVIE"],
      serverIds: [server.id],
      groups: [
        {
          id: "g1",
          condition: "OR",
          rules: [
            { id: "r1", field: "title", operator: "matchesWildcard", value: "*Matrix*", condition: "OR" },
            { id: "r2", field: "title", operator: "matchesWildcard", value: "Star Wars*", condition: "OR" },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
    };

    const queryResult = await executeQuery(query, user.id, 1, 1000);
    const queryIds = toIdSet(queryResult.items as unknown as MatchableItem[]);
    expect(queryIds).toEqual(new Set([match1.id, match2.id]));

    const body = convertQueryToRuleSetBody(query, {
      name: "Wildcards",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });
    const ruleMatches = await evaluateLifecycleRules(
      body.rules as unknown as LifecycleRuleGroup[],
      "MOVIE",
      body.serverIds,
    );
    expect(toIdSet(ruleMatches as unknown as MatchableItem[])).toEqual(queryIds);
  });

  it("produces identical match sets for a nested group tree", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Match: 2010+ AND (4K OR 1080p)
    const match1 = await createTestMediaItem(library.id, { title: "A", year: 2020, resolution: "4k" });
    const match2 = await createTestMediaItem(library.id, { title: "B", year: 2015, resolution: "1080p" });
    // Not match: 2010+ but SD
    await createTestMediaItem(library.id, { title: "C", year: 2020, resolution: "sd" });
    // Not match: too old, even at 4K
    await createTestMediaItem(library.id, { title: "D", year: 2005, resolution: "4k" });

    const query: QueryDefinition = {
      mediaTypes: ["MOVIE"],
      serverIds: [server.id],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "year", operator: "greaterThanOrEqual", value: 2010, condition: "AND" },
          ],
          groups: [
            {
              id: "g2",
              condition: "AND",
              rules: [
                { id: "r2", field: "resolution", operator: "equals", value: "4k", condition: "OR" },
                { id: "r3", field: "resolution", operator: "equals", value: "1080p", condition: "OR" },
              ],
              groups: [],
            },
          ],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
    };

    const queryResult = await executeQuery(query, user.id, 1, 1000);
    const queryIds = toIdSet(queryResult.items as unknown as MatchableItem[]);
    expect(queryIds).toEqual(new Set([match1.id, match2.id]));

    const body = convertQueryToRuleSetBody(query, {
      name: "Modern HD/4K",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });
    const ruleMatches = await evaluateLifecycleRules(
      body.rules as unknown as LifecycleRuleGroup[],
      "MOVIE",
      body.serverIds,
    );
    expect(toIdSet(ruleMatches as unknown as MatchableItem[])).toEqual(queryIds);
  });

  it("produces identical match sets when negate is set on a rule", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const match1 = await createTestMediaItem(library.id, { title: "A", playCount: 0 });
    await createTestMediaItem(library.id, { title: "B", playCount: 5 });
    const match2 = await createTestMediaItem(library.id, { title: "C", playCount: 0 });

    const query: QueryDefinition = {
      mediaTypes: ["MOVIE"],
      serverIds: [server.id],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND", negate: true },
          ],
          groups: [],
        },
      ],
      sortBy: "title",
      sortOrder: "asc",
    };

    const queryResult = await executeQuery(query, user.id, 1, 1000);
    const queryIds = toIdSet(queryResult.items as unknown as MatchableItem[]);
    expect(queryIds).toEqual(new Set([match1.id, match2.id]));

    const body = convertQueryToRuleSetBody(query, {
      name: "Unwatched",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });
    const ruleMatches = await evaluateLifecycleRules(
      body.rules as unknown as LifecycleRuleGroup[],
      "MOVIE",
      body.serverIds,
    );
    expect(toIdSet(ruleMatches as unknown as MatchableItem[])).toEqual(queryIds);
  });
});
