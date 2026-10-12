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
  createTestRuleSet,
  createTestRuleMatch,
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

import { GET } from "@/app/api/lifecycle/summary/route";
import { GET as getStats } from "@/app/api/lifecycle/stats/route";
import { GET as getMatches } from "@/app/api/lifecycle/rules/matches/route";

interface Summary {
  ruleTotal: number;
  ruleEnabled: number;
  matchCount: number;
  matchRuleSets: number;
  pendingCount: number;
  pendingBytes: string;
  reclaimedBytes: string;
  reclaimedActions: number;
}

describe("GET /api/lifecycle/summary", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/lifecycle/summary" });
    await expectJson(response, 401);
  });

  it("reads all zeros with no rule sets", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<Summary>(await callRoute(GET, { url: "/api/lifecycle/summary" }), 200);
    expect(body).toEqual({
      ruleTotal: 0,
      ruleEnabled: 0,
      matchCount: 0,
      matchRuleSets: 0,
      pendingCount: 0,
      pendingBytes: "0",
      reclaimedBytes: "0",
      reclaimedActions: 0,
    });
  });

  it("counts rule sets, the matches the Matches page lists, and the deletion figures /stats reports", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const items = await Promise.all(
      [100, 200, 300, 400].map((size, i) =>
        createTestMediaItem(library.id, { title: `Movie ${i}`, type: "MOVIE", fileSize: BigInt(size) }),
      ),
    );
    const deleting = await createTestRuleSet(user.id, {
      name: "Delete", type: "MOVIE", enabled: true, actionEnabled: true, actionType: "DELETE_RADARR",
    });
    const watching = await createTestRuleSet(user.id, { name: "Watch", type: "MOVIE", enabled: true });
    const disabled = await createTestRuleSet(user.id, { name: "Off", type: "MOVIE", enabled: false });

    await createTestRuleMatch(deleting.id, items[0].id);
    await createTestRuleMatch(deleting.id, items[1].id);
    await createTestRuleMatch(watching.id, items[2].id);
    // A disabled rule set's matches are not listed on the Matches page.
    await createTestRuleMatch(disabled.id, items[3].id);

    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: items[0].id, ruleSetId: deleting.id, actionType: "DELETE_RADARR",
        status: "PENDING", scheduledFor: new Date(),
      },
    });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, ruleSetName: "Removed", ruleSetType: "MOVIE", actionType: "DELETE_RADARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), deletedBytes: BigInt(5000),
      },
    });

    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<Summary>(await callRoute(GET, { url: "/api/lifecycle/summary" }), 200);

    expect(body).toEqual({
      ruleTotal: 3,
      ruleEnabled: 2,
      matchCount: 3,
      matchRuleSets: 2,
      // items[0] through its PENDING action, items[1] as an upcoming match.
      pendingCount: 2,
      pendingBytes: "300",
      reclaimedBytes: "5000",
      reclaimedActions: 1,
    });

    const stats = await expectJson<{ pendingCount: number; pendingBytes: string; totalBytesDeleted: string; actionCount: number }>(
      await callRoute(getStats, { url: "/api/lifecycle/stats" }),
      200,
    );
    expect(body.pendingCount).toBe(stats.pendingCount);
    expect(body.pendingBytes).toBe(stats.pendingBytes);
    expect(body.reclaimedBytes).toBe(stats.totalBytesDeleted);
    expect(body.reclaimedActions).toBe(stats.actionCount);

    const matches = await expectJson<{ ruleMatches: { count: number }[] }>(
      await callRoute(getMatches, { url: "/api/lifecycle/rules/matches" }),
      200,
    );
    expect(body.matchCount).toBe(matches.ruleMatches.reduce((sum, g) => sum + g.count, 0));
    expect(body.matchRuleSets).toBe(matches.ruleMatches.filter((g) => g.count > 0).length);
  });
});
