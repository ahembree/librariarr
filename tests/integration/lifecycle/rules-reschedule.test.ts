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
import { POST } from "@/app/api/lifecycle/rules/[id]/reschedule-actions/route";

describe("POST /api/lifecycle/rules/[id]/reschedule-actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function createTestAction(
    userId: string,
    mediaItemId: string,
    ruleSetId: string,
    overrides?: Partial<{
      status: "PENDING" | "COMPLETED" | "FAILED";
      scheduledFor: Date;
    }>
  ) {
    const prisma = getTestPrisma();
    return prisma.lifecycleAction.create({
      data: {
        userId,
        mediaItemId,
        ruleSetId,
        actionType: "DO_NOTHING",
        status: overrides?.status ?? "PENDING",
        scheduledFor: overrides?.scheduledFor ?? new Date(),
      },
    });
  }

  it("returns 401 when not authenticated", async () => {
    const response = await callRouteWithParams(
      POST,
      { id: "some-id" },
      {
        url: "/api/lifecycle/rules/some-id/reschedule-actions",
        method: "POST",
      }
    );
    await expectJson(response, 401);
  });

  it("returns 404 for non-existent rule set", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: "nonexistent" },
      {
        url: "/api/lifecycle/rules/nonexistent/reschedule-actions",
        method: "POST",
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
        url: `/api/lifecycle/rules/${ruleSet.id}/reschedule-actions`,
        method: "POST",
      }
    );
    await expectJson(response, 404);
  });

  it("reschedules PENDING actions using actionDelayDays", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Delayed",
      actionDelayDays: 7,
    });

    const oldDate = new Date("2020-01-01");
    await createTestAction(user.id, item.id, ruleSet.id, {
      status: "PENDING",
      scheduledFor: oldDate,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const beforeCall = new Date();
    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/reschedule-actions`,
        method: "POST",
      }
    );

    const body = await expectJson<{ updated: number }>(response, 200);
    expect(body.updated).toBe(1);

    const prisma = getTestPrisma();
    const actions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(actions).toHaveLength(1);

    const newScheduled = actions[0].scheduledFor;
    // Should be roughly 7 days from now, not the old date
    const expectedMin = new Date(beforeCall.getTime() + 6 * 24 * 60 * 60 * 1000);
    expect(newScheduled.getTime()).toBeGreaterThan(expectedMin.getTime());
  });

  it("does not reschedule COMPLETED or FAILED actions", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item1 = await createTestMediaItem(library.id, { title: "Movie 1", type: "MOVIE" });
    const item2 = await createTestMediaItem(library.id, { title: "Movie 2", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Test",
      actionDelayDays: 5,
    });

    const completedDate = new Date("2020-06-01");
    const failedDate = new Date("2020-07-01");
    await createTestAction(user.id, item1.id, ruleSet.id, {
      status: "COMPLETED",
      scheduledFor: completedDate,
    });
    await createTestAction(user.id, item2.id, ruleSet.id, {
      status: "FAILED",
      scheduledFor: failedDate,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/reschedule-actions`,
        method: "POST",
      }
    );

    const body = await expectJson<{ updated: number }>(response, 200);
    expect(body.updated).toBe(0);

    // Verify dates unchanged
    const prisma = getTestPrisma();
    const actions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: ruleSet.id },
      orderBy: { scheduledFor: "asc" },
    });
    expect(actions[0].scheduledFor.getTime()).toBe(completedDate.getTime());
    expect(actions[1].scheduledFor.getTime()).toBe(failedDate.getTime());
  });

  it("returns updated count of 0 when no pending actions exist", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Empty",
      actionDelayDays: 3,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRouteWithParams(
      POST,
      { id: ruleSet.id },
      {
        url: `/api/lifecycle/rules/${ruleSet.id}/reschedule-actions`,
        method: "POST",
      }
    );

    const body = await expectJson<{ updated: number }>(response, 200);
    expect(body.updated).toBe(0);
  });
});
