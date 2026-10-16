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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The DELETE handler re-syncs the collection a rule set fed.
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/lifecycle/rules/route";
import { PUT, DELETE } from "@/app/api/lifecycle/rules/[id]/route";
import { GET as mediaDistinctGET } from "@/app/api/media/distinct-values/route";
import { GET as queryDistinctGET } from "@/app/api/query/distinct-values/route";

const rules = [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }];

/**
 * "Matched By Rule Set" lists rule set names out of the two cached
 * distinct-values payloads (5-minute TTL), which no media mutation touches. A
 * rule set created, renamed or deleted has to drop them, or the rule editor
 * and the Query page offer the old names until the TTL runs out.
 */
describe("rule set names in the cached dropdown values", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    appCache.clear();
    await disconnectTestDb();
  });

  async function offered() {
    const media = await expectJson<{ matchedByRuleSet: string[] }>(
      await callRoute(mediaDistinctGET, { url: "/api/media/distinct-values" }),
      200,
    );
    const query = await expectJson<{ matchedByRuleSet: string[] }>(
      await callRoute(queryDistinctGET, { url: "/api/query/distinct-values" }),
      200,
    );
    return { media: media.matchedByRuleSet, query: query.matchedByRuleSet };
  }

  it("offers a created rule set, then its new name, and drops it once deleted", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Warm both caches before the rule set exists.
    expect(await offered()).toEqual({ media: [], query: [] });

    const created = await expectJson<{ ruleSet: { id: string } }>(
      await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Keep", type: "MOVIE", rules, serverIds: [server.id] },
      }),
      201,
    );
    expect(await offered()).toEqual({ media: ["Keep"], query: ["Keep"] });

    await expectJson(
      await callRouteWithParams(PUT, { id: created.ruleSet.id }, {
        url: `/api/lifecycle/rules/${created.ruleSet.id}`,
        method: "PUT",
        body: { name: "Keep Forever" },
      }),
      200,
    );
    expect(await offered()).toEqual({ media: ["Keep Forever"], query: ["Keep Forever"] });

    await expectJson(
      await callRouteWithParams(DELETE, { id: created.ruleSet.id }, {
        url: `/api/lifecycle/rules/${created.ruleSet.id}`,
        method: "DELETE",
      }),
      200,
    );
    expect(await offered()).toEqual({ media: [], query: [] });
  });
});
