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

import { GET } from "@/app/api/lifecycle/stats/route";

describe("GET /api/lifecycle/stats", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    await expectJson(response, 401);
  });

  it("counts an upcoming delete match even if a completed NON-delete action exists on the same item", async () => {
    // Regression: a delete rule will delete the item regardless of any prior
    // unmonitor/search (or an action that was changed to delete). The completed
    // non-delete action must NOT exclude it from the pending-deletion estimate.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE", fileSize: BigInt(1000) });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Delete rule",
      enabled: true,
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    // Same rule set previously ran a SEARCH on this item, then its action was
    // changed to DELETE. The item now has an upcoming delete match.
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "SEARCH_RADARR", status: "COMPLETED",
        scheduledFor: new Date("2020-01-01T00:00:00Z"), executedAt: new Date("2020-01-02T00:00:00Z"),
      },
    });
    await createTestRuleMatch(ruleSet.id, item.id);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    const body = await expectJson<{ pendingBytes: string; pendingCount: number }>(response, 200);

    expect(body.pendingCount).toBe(1);
    expect(body.pendingBytes).toBe("1000");
  });

  it("does not double-count an upcoming match that already has a PENDING delete action", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE", fileSize: BigInt(1000) });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Delete rule",
      enabled: true,
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "DELETE_RADARR", status: "PENDING", scheduledFor: new Date(),
      },
    });
    await createTestRuleMatch(ruleSet.id, item.id);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    const body = await expectJson<{ pendingBytes: string; pendingCount: number }>(response, 200);

    // Counted once (via the PENDING action), not twice (PENDING + upcoming match).
    expect(body.pendingCount).toBe(1);
    expect(body.pendingBytes).toBe("1000");
  });
});
