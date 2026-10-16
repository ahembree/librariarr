import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { appCache } from "@/lib/cache/memory-cache";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));

// Import route handlers AFTER mocks
import { GET as mediaDistinctGET } from "@/app/api/media/distinct-values/route";
import { GET as queryDistinctGET } from "@/app/api/query/distinct-values/route";
import { POST } from "@/app/api/lifecycle/rules/route";
import { PUT, DELETE } from "@/app/api/lifecycle/rules/[id]/route";

/**
 * Both distinct-values payloads list rule set names ("Matched By Rule Set")
 * and are cached for five minutes. No rule set route dropped them, so the
 * rule editor kept offering the old list after a create, rename or delete.
 */
describe("distinct values after rule set changes", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function ruleSetNames() {
    const media = await expectJson<{ matchedByRuleSet: string[] }>(
      await callRoute(mediaDistinctGET, { url: "/api/media/distinct-values" }),
      200,
    );
    const query = await expectJson<{ matchedByRuleSet: string[] }>(
      await callRoute(queryDistinctGET, { url: "/api/query/distinct-values" }),
      200,
    );
    expect(query.matchedByRuleSet).toEqual(media.matchedByRuleSet);
    return media.matchedByRuleSet;
  }

  it("lists a rule set as soon as it is created, renamed or deleted", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(await ruleSetNames()).toEqual([]); // now cached

    const created = await expectJson<{ ruleSet: { id: string } }>(
      await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Unwatched",
          type: "MOVIE",
          rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
          serverIds: [server.id],
        },
      }),
      201,
    );
    expect(await ruleSetNames()).toEqual(["Unwatched"]);

    await expectJson(
      await callRouteWithParams(PUT, { id: created.ruleSet.id }, {
        method: "PUT",
        body: { name: "Never Watched" },
      }),
      200,
    );
    expect(await ruleSetNames()).toEqual(["Never Watched"]);

    await expectJson(
      await callRouteWithParams(DELETE, { id: created.ruleSet.id }, { method: "DELETE" }),
      200,
    );
    expect(await ruleSetNames()).toEqual([]);
  });
});
